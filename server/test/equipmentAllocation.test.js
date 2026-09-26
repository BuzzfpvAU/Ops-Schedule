import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initDb } from '../src/db.js';
import jobsRoutes from '../src/routes/jobs.js';
import equipmentRoutes from '../src/routes/equipment.js';
import { signToken } from '../src/middleware/auth.js';

let db, server, baseUrl, dbPath;
let currentUser, adminToken;

const D = (offsetDays) => new Date(Date.now() + 10 * 3600 * 1000 + offsetDays * 86400000).toISOString().slice(0, 10);

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-alloc-')), 'test.db');
  process.env.DATABASE_PATH = dbPath;
  db = initDb();

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, res, next) => { req.db = db; req.user = currentUser; next(); });
  app.use('/api/jobs', jobsRoutes);
  app.use('/api/equipment', equipmentRoutes);

  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  adminToken = signToken('a1', true);
});

after(() => {
  server?.close();
  db?.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

const call = (method, p, body) => fetch(`${baseUrl}/api/jobs${p}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// Equipment router routes carry their own requireAuth — pass a real cookie token.
const callEq = (method, p, body, withCookie = true) => fetch(`${baseUrl}/api/equipment${p}`, {
  method,
  headers: {
    'Content-Type': 'application/json',
    ...(withCookie ? { Cookie: `auth_token=${adminToken}` } : {}),
  },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const seedMember = (id, name, extra = {}) => {
  db.prepare('INSERT INTO team_members (id, name) VALUES (?, ?)').run(id, name);
  for (const [k, v] of Object.entries(extra)) {
    db.prepare(`UPDATE team_members SET ${k} = ? WHERE id = ?`).run(v, id);
  }
};
const seedJob = (id, code, extra = {}) => {
  db.prepare('INSERT INTO jobs (id, code, name) VALUES (?, ?, ?)').run(id, code, `Job ${code}`);
  for (const [k, v] of Object.entries(extra)) {
    db.prepare(`UPDATE jobs SET ${k} = ? WHERE id = ?`).run(v, id);
  }
};
const seedEntry = (id, memberId, jobId, date, status = 'tentative') =>
  db.prepare('INSERT INTO schedule_entries (id, team_member_id, job_id, date, status) VALUES (?, ?, ?, ?, ?)')
    .run(id, memberId, jobId, date, status);
const bookingDates = (jobId, memberId) => db.prepare(
  'SELECT date FROM schedule_entries WHERE job_id = ? AND team_member_id = ? ORDER BY date'
).all(jobId, memberId).map(r => r.date);

beforeEach(() => {
  db.exec(`
    DELETE FROM notifications;
    DELETE FROM schedule_entries;
    DELETE FROM job_equipment;
    DELETE FROM equipment_kit_items;
    DELETE FROM equipment_kits;
    DELETE FROM job_checklist_items;
    DELETE FROM jobs;
    DELETE FROM team_members;
  `);
  currentUser = { memberId: 'a1', name: 'Admin', isAdmin: true, isViewer: false };
  seedMember('a1', 'Admin', { is_admin: 1 });
  seedMember('a2', 'Second Admin', { is_admin: 1 });
  seedMember('m1', 'Alex');
  seedMember('e1', 'Mavic', { is_equipment: 1, serviceable: 1 });
  seedJob('j1', 'T1', { crew_size: 1 });
  seedEntry('r1', 'm1', 'j1', D(10));
  seedEntry('r2', 'm1', 'j1', D(11));
});

test('assigning with custom pads books span ± pads', async () => {
  const a = await call('POST', '/j1/equipment', { equipment_id: 'e1', pad_before: 2, pad_after: 0 });
  assert.equal(a.status, 201);
  const body = await a.json();
  assert.equal(body.pad_before, 2);
  assert.equal(body.pad_after, 0);
  assert.equal(body.booked_from, D(8));
  assert.equal(body.booked_to, D(11));
  assert.deepEqual(bookingDates('j1', 'e1'), [D(8), D(9), D(10), D(11)]);
});

test('assignment surfaces conflicts with other jobs; card rows carry them too', async () => {
  seedJob('j2', 'T2');
  seedEntry('x1', 'e1', 'j2', D(10)); // Mavic already out on T2

  const a = await call('POST', '/j1/equipment', { equipment_id: 'e1' });
  assert.equal(a.status, 201);
  const body = await a.json();
  assert.equal(body.conflicts.length, 1);
  assert.equal(body.conflicts[0].code, 'T2');

  const card = await (await call('GET', '/j1')).json();
  assert.equal(card.equipment[0].conflicts[0].code, 'T2');
  assert.equal(card.equipment[0].status, 'tentative');
});

test('confirm-all blocks on conflicts, override confirms + records + notifies', async () => {
  seedJob('j2', 'T2');
  seedEntry('x1', 'e1', 'j2', D(10));
  await call('POST', '/j1/equipment', { equipment_id: 'e1' });

  let res = await call('POST', '/j1/equipment/confirm');
  assert.equal(res.status, 409);
  let body = await res.json();
  assert.equal(body.can_override, true);
  assert.equal(body.conflicts[0].code, 'T2');

  res = await call('POST', '/j1/equipment/confirm', { override_reason: 'Mavic swapped to spare for T2' });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.confirmed, 1);

  const je = db.prepare("SELECT status FROM job_equipment WHERE job_id = 'j1'").get();
  assert.equal(je.status, 'confirmed');
  const notes = db.prepare("SELECT notes FROM jobs WHERE id = 'j1'").get().notes;
  assert.match(notes, /Kit allocation confirmed with 1 conflict/);
  const n = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE team_member_id = 'a2'").get();
  assert.equal(n.c, 1);
});

test('kits CRUD + apply-kit adds, skips unserviceable, books the job window', async () => {
  // No cookie → 401 on kits
  assert.equal((await callEq('GET', '/kits', undefined, false)).status, 401);

  seedMember('e2', 'Broken Gimbal', { is_equipment: 1, serviceable: 0 });

  let res = await callEq('POST', '/kits', { name: 'Standard drone kit', items: ['e1', 'e2'] });
  assert.equal(res.status, 201);
  const kit = await res.json();

  res = await callEq('GET', '/kits');
  const kits = await res.json();
  assert.equal(kits.length, 1);
  assert.equal(kits[0].item_count, 2);

  // Apply to j1 — e1 added + booked, e2 skipped (unserviceable)
  res = await call('POST', '/j1/apply-kit', { kit_id: kit.id });
  assert.equal(res.status, 201);
  const applied = await res.json();
  assert.deepEqual(applied.added.map(a => a.id), ['e1']);
  assert.equal(applied.skipped[0].id, 'e2');
  assert.equal(applied.skipped[0].reason, 'unserviceable');
  // Default transit pads are 0, so kit books exactly the job's days
  assert.deepEqual(bookingDates('j1', 'e1'), [D(10), D(11)]);

  // Re-apply — e1 now skipped as already on the job
  res = await call('POST', '/j1/apply-kit', { kit_id: kit.id });
  const reapplied = await res.json();
  assert.equal(reapplied.added.length, 0);
  assert.ok(reapplied.skipped.some(s => s.id === 'e1' && s.reason === 'already on this job'));

  // Rename + delete
  res = await callEq('PUT', `/kits/${kit.id}`, { name: 'Renamed kit' });
  assert.equal((await res.json()).name, 'Renamed kit');
  res = await callEq('DELETE', `/kits/${kit.id}`);
  assert.equal(res.status, 200);
  assert.equal((await (await callEq('GET', '/kits')).json()).length, 0);
});

test('confirm with no equipment returns 400; missing kit returns 404', async () => {
  const res = await call('POST', '/j1/equipment/confirm');
  assert.equal(res.status, 400);
  const r2 = await call('POST', '/j1/apply-kit', { kit_id: 'nope' });
  assert.equal(r2.status, 404);
});
