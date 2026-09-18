import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { initDb } from '../src/db.js';
import jobsRoutes from '../src/routes/jobs.js';
import { computeReadiness } from '../src/services/readiness.js';

let db, server, baseUrl, dbPath;
let currentUser;

// AEST-safe date helpers (same convention as the app: +10h)
const D = (offsetDays) => new Date(Date.now() + 10 * 3600 * 1000 + offsetDays * 86400000).toISOString().slice(0, 10);

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-readiness-')), 'test.db');
  process.env.DATABASE_PATH = dbPath;
  db = initDb();

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; req.user = currentUser; next(); });
  app.use('/api/jobs', jobsRoutes);

  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
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
const seedCompliance = (id, memberId, type, expiresAt) =>
  db.prepare('INSERT INTO member_compliance (id, team_member_id, type, expires_at) VALUES (?, ?, ?, ?)')
    .run(id, memberId, type, expiresAt);
const tickStage = (jobId, stage) =>
  db.prepare('UPDATE job_checklist_items SET done = 1 WHERE job_id = ? AND stage = ? AND required = 1').run(jobId, stage);

// Full happy-path fixture: crew of 2 (D+10..D+12), compliant, kit booked, planning items ticked.
function seedReadyJob() {
  seedJob('j1', 'T1', { crew_size: 2, status: 'planning' });
  seedMember('m1', 'Alex');
  seedMember('m2', 'Sam');
  seedMember('e1', 'Mavic', { is_equipment: 1, serviceable: 1 });
  seedEntry('r1', 'm1', 'j1', D(10));
  seedEntry('r2', 'm1', 'j1', D(11));
  seedEntry('r3', 'm1', 'j1', D(12));
  seedEntry('r4', 'm2', 'j1', D(10));
  seedEntry('r5', 'm2', 'j1', D(11));
  seedEntry('r6', 'm2', 'j1', D(12));
  seedCompliance('c1', 'm1', 'CASA RePL', D(200));
  seedCompliance('c2', 'm2', 'CASA RePL', D(200));
  db.prepare('INSERT INTO job_checklist_items (id, job_id, category, label, required, stage, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('ck1', 'j1', 'admin', 'Site inductions arranged', 1, 'planning', 0);
  db.prepare('INSERT INTO job_checklist_items (id, job_id, category, label, required, stage, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('ck2', 'j1', 'equipment', 'Charge batteries', 1, 'active', 1);
  db.prepare('INSERT INTO job_checklist_items (id, job_id, category, label, required, stage, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('ck3', 'j1', 'equipment', 'Gear returned & checked in', 1, 'complete', 2);
}

beforeEach(() => {
  db.exec(`
    DELETE FROM notifications;
    DELETE FROM schedule_entries;
    DELETE FROM job_equipment;
    DELETE FROM job_checklist_items;
    DELETE FROM job_requirements;
    DELETE FROM member_compliance;
    DELETE FROM jobs;
    DELETE FROM team_members;
  `);
  currentUser = { memberId: 'a1', name: 'Admin', isAdmin: true, isViewer: false };
  seedMember('a1', 'Admin One', { is_admin: 1 });
});

// ── Gate unit tests ─────────────────────────────────────────────────────────

test('crew gate: fails short, passes when crew_size met', async () => {
  seedReadyJob();
  db.prepare("DELETE FROM schedule_entries WHERE id IN ('r4','r5','r6')").run(); // drop Sam
  let r = computeReadiness(db, 'j1');
  assert.equal(r.gates.crew.status, 'fail');
  assert.match(r.gates.crew.checks[0].note, /1 of 2/);

  seedEntry('r4', 'm2', 'j1', D(10));
  seedEntry('r5', 'm2', 'j1', D(11));
  seedEntry('r6', 'm2', 'j1', D(12));
  r = computeReadiness(db, 'j1');
  assert.equal(r.gates.crew.status, 'pass');
});

test('crew gate: leave/unavailable clash fails with the member named', async () => {
  seedReadyJob();
  seedJob('jother', 'OTHER');
  seedEntry('lv1', 'm1', 'jother', D(11), 'leave');
  const r = computeReadiness(db, 'j1');
  assert.equal(r.gates.crew.status, 'fail');
  const clash = r.gates.crew.checks.find(c => c.label === 'Alex');
  assert.ok(clash && !clash.ok && /leave/.test(clash.note));
});

test('compliance gate: expired record fails (no requirements defined)', async () => {
  seedReadyJob();
  db.prepare("UPDATE member_compliance SET expires_at = ? WHERE id = 'c1'").run(D(11)); // before span end D+12
  let r = computeReadiness(db, 'j1');
  assert.equal(r.gates.compliance.status, 'fail');
  assert.match(r.gates.compliance.checks.find(c => c.label === 'Alex').note, /expired/);

  db.prepare("UPDATE member_compliance SET expires_at = ? WHERE id = 'c1'").run(D(60));
  r = computeReadiness(db, 'j1');
  assert.equal(r.gates.compliance.status, 'pass');
});

test('compliance gate: job requirements must be held by every crew member', async () => {
  seedReadyJob();
  db.prepare("INSERT INTO job_requirements (id, job_id, compliance_type) VALUES ('req1', 'j1', 'White Card')").run();
  let r = computeReadiness(db, 'j1');
  assert.equal(r.gates.compliance.status, 'fail');
  assert.match(r.gates.compliance.checks.find(c => c.label === 'Sam').note, /missing White Card/);

  seedCompliance('c3', 'm2', 'White Card', D(300));
  r = computeReadiness(db, 'j1');
  assert.equal(r.gates.compliance.status, 'fail'); // Alex still missing
  seedCompliance('c4', 'm1', 'White Card', D(300));
  r = computeReadiness(db, 'j1');
  assert.equal(r.gates.compliance.status, 'pass');
});

test('kit gate: not booked, unserviceable and cross-job overlap all fail', async () => {
  seedReadyJob();
  const a = await call('POST', '/j1/equipment', { equipment_id: 'e1' });
  assert.equal(a.status, 201);
  let r = computeReadiness(db, 'j1');
  assert.equal(r.gates.kit.status, 'pass');

  // wipe the booking → not booked
  db.prepare("DELETE FROM schedule_entries WHERE team_member_id = 'e1'").run();
  r = computeReadiness(db, 'j1');
  assert.equal(r.gates.kit.status, 'fail');
  assert.match(r.gates.kit.checks[0].note, /not booked/);

  // rebook and mark unserviceable
  seedEntry('bk1', 'e1', 'j1', D(10));
  seedEntry('bk2', 'e1', 'j1', D(11));
  seedEntry('bk3', 'e1', 'j1', D(12));
  db.prepare("UPDATE team_members SET serviceable = 0 WHERE id = 'e1'").run();
  r = computeReadiness(db, 'j1');
  assert.equal(r.gates.kit.status, 'fail');
  assert.match(r.gates.kit.checks[0].note, /unserviceable/);
  db.prepare("UPDATE team_members SET serviceable = 1 WHERE id = 'e1'").run();

  // overlap with another job
  seedJob('j2', 'T2');
  seedEntry('cf1', 'e1', 'j2', D(11));
  r = computeReadiness(db, 'j1');
  assert.equal(r.gates.kit.status, 'fail');
  assert.match(r.gates.kit.checks[0].note, /overlaps T2/);
});

test('admin gate: done or scheduled-due-before-start passes; overdue fails', async () => {
  seedReadyJob();
  let r = computeReadiness(db, 'j1');
  assert.equal(r.gates.admin.status, 'fail'); // 'Site inductions arranged' not done

  // scheduled with a due date before start → passes
  db.prepare("UPDATE job_checklist_items SET due_date = ? WHERE id = 'ck1'").run(D(5));
  r = computeReadiness(db, 'j1');
  assert.equal(r.gates.admin.status, 'pass');
  assert.match(r.gates.admin.checks[0].note, /scheduled/);

  // overdue due date → fails
  db.prepare("UPDATE job_checklist_items SET due_date = ? WHERE id = 'ck1'").run(D(-2));
  r = computeReadiness(db, 'j1');
  assert.equal(r.gates.admin.status, 'fail');
  assert.match(r.gates.admin.checks[0].note, /overdue/);

  // done → passes
  db.prepare("UPDATE job_checklist_items SET done = 1, due_date = '' WHERE id = 'ck1'").run();
  r = computeReadiness(db, 'j1');
  assert.equal(r.gates.admin.status, 'pass');
});

test('at_risk: near-start job with failing gates; far-out planning job is not at risk', async () => {
  seedReadyJob();
  let r = computeReadiness(db, 'j1');
  assert.equal(r.at_risk, false); // starts D+10 (8+ days away) and still planning

  // move span to 3 days out
  db.exec("DELETE FROM schedule_entries");
  for (const [i, d] of [D(3), D(4)].entries()) {
    seedEntry(`n1${i}`, 'm1', 'j1', d);
    seedEntry(`n2${i}`, 'm2', 'j1', d);
  }
  r = computeReadiness(db, 'j1');
  assert.equal(r.at_risk, true);
  assert.ok(r.failing_gates.includes('admin'));
});

// ── Endpoint tests ──────────────────────────────────────────────────────────

test('POST /:id/status blocks with reasons, then applies with override', async () => {
  seedReadyJob();
  let res = await call('POST', '/j1/status', { status: 'confirmed' });
  assert.equal(res.status, 409);
  let body = await res.json();
  assert.equal(body.error, 'Gates not satisfied');
  assert.ok(body.failing_gates.includes('admin'));
  assert.ok(body.reasons.length > 0);
  assert.equal(body.can_override, true);

  res = await call('POST', '/j1/status', { status: 'confirmed', override_reason: 'Client pushed — docs on the way' });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.job.status, 'confirmed');
  const notes = db.prepare("SELECT notes FROM jobs WHERE id = 'j1'").get().notes;
  assert.match(notes, /Status override to confirmed by Admin/);
});

test('POST /:id/status requires admin', async () => {
  seedReadyJob();
  currentUser = { memberId: 'm1', name: 'Alex', isAdmin: false, isViewer: false };
  const res = await call('POST', '/j1/status', { status: 'confirmed' });
  assert.equal(res.status, 403);
});

test('full happy path: planning → confirmed → active → complete through the gates', async () => {
  seedReadyJob();
  await call('POST', '/j1/equipment', { equipment_id: 'e1' });
  tickStage('j1', 'planning');

  let res = await call('POST', '/j1/status', { status: 'confirmed' });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));

  // Active still blocked on dispatch items
  res = await call('POST', '/j1/status', { status: 'active' });
  assert.equal(res.status, 409);
  tickStage('j1', 'active');
  res = await call('POST', '/j1/status', { status: 'active' });
  assert.equal(res.status, 200);

  // Complete blocked on close-out items
  res = await call('POST', '/j1/status', { status: 'complete' });
  assert.equal(res.status, 409);
  tickStage('j1', 'complete');
  res = await call('POST', '/j1/status', { status: 'complete' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).job.status, 'complete');
});

test('status change notifies the crew', async () => {
  seedReadyJob();
  await call('POST', '/j1/equipment', { equipment_id: 'e1' });
  tickStage('j1', 'planning');
  await call('POST', '/j1/status', { status: 'confirmed' });
  const n = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE team_member_id = 'm1'").get();
  assert.equal(n.c, 1);
});

test('GET /:id/readiness returns the full gate payload', async () => {
  seedReadyJob();
  const res = await call('GET', '/j1/readiness');
  assert.equal(res.status, 200);
  const r = await res.json();
  for (const g of ['crew', 'compliance', 'kit', 'admin', 'prep', 'closeout', 'logistics']) {
    assert.ok(r.gates[g], `gate ${g} present`);
  }
  assert.equal(r.ready, false);
});

test('GET /attention lists unallocated jobs and sweeps at-risk notifications', async () => {
  seedReadyJob();
  seedMember('a2', 'Admin Two', { is_admin: 1 });
  // Move to 3 days out so it's at_risk, and leave it under-crewed (drop Sam)
  db.exec('DELETE FROM schedule_entries');
  seedEntry('n1', 'm1', 'j1', D(3));
  seedEntry('n2', 'm1', 'j1', D(4));

  let res = await call('GET', '/attention');
  assert.equal(res.status, 200);
  let list = await res.json();
  assert.equal(list.length, 1);
  assert.equal(list[0].unallocated, true);
  assert.equal(list[0].at_risk, true);

  const a2 = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE team_member_id = 'a2'").get();
  assert.equal(a2.c, 1); // swept once

  // Second call within a day is deduped
  await call('GET', '/attention');
  const a2b = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE team_member_id = 'a2'").get();
  assert.equal(a2b.c, 1);
});

test('PUT /:id status changes are gated too', async () => {
  seedReadyJob();
  let res = await call('PUT', '/j1', { status: 'confirmed' });
  assert.equal(res.status, 409);
  res = await call('PUT', '/j1', { status: 'confirmed', override_reason: 'documents pending' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'confirmed');

  // Non-status edits pass through untouched
  res = await call('PUT', '/j1', { name: 'Renamed job' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, 'Renamed job');
});

test('requirements CRUD', async () => {
  seedReadyJob();
  let res = await call('POST', '/j1/requirements', { compliance_type: 'White Card' });
  assert.equal(res.status, 201);
  const req = await res.json();
  res = await call('POST', '/j1/requirements', { compliance_type: 'white card' });
  assert.equal(res.status, 409); // case-insensitive duplicate
  res = await call('GET', '/j1/requirements');
  assert.equal((await res.json()).length, 1);
  res = await call('DELETE', `/requirements/${req.id}`);
  assert.equal(res.status, 200);
  res = await call('GET', '/j1/requirements');
  assert.equal((await res.json()).length, 0);
});
