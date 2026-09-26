import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { initDb } from '../src/db.js';
import jobsRoutes from '../src/routes/jobs.js';

// Cancelling a job releases its crew and kit from today onward.

let db, server, baseUrl, dbPath;

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-')), 'test.db');
  process.env.DATABASE_PATH = dbPath;
  db = initDb();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; req.user = { memberId: 'm1', isAdmin: true, isViewer: false }; next(); });
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

beforeEach(() => {
  db.exec('DELETE FROM schedule_entries; DELETE FROM job_equipment; DELETE FROM jobs;');
  db.exec("DELETE FROM team_members WHERE id IN ('m1','m2','e1')");
  db.prepare("INSERT INTO team_members (id, name) VALUES ('m1', 'Alex')").run();
  db.prepare("INSERT INTO team_members (id, name) VALUES ('m2', 'Sam')").run();
  db.prepare("INSERT INTO team_members (id, name, is_equipment) VALUES ('e1', 'Mavic', 1)").run();
  db.exec("DELETE FROM team_members WHERE id = 'e2'");
  db.prepare("INSERT INTO team_members (id, name, is_equipment) VALUES ('e2', 'Case', 1)").run();
  db.prepare(`INSERT INTO jobs (id, code, name, planned_start, planned_end)
              VALUES ('j1', 'T1', 'Shift job', '2026-10-05', '2026-10-07')`).run();
  db.prepare("INSERT INTO jobs (id, code, name) VALUES ('j2', 'T2', 'Other job')").run();
});

const D = (offset) => new Date(Date.now() + 10 * 3600 * 1000 + offset * 86400000).toISOString().slice(0, 10);

let n = 0;
const book = (jobId, memberId, offsets) => {
  const ins = db.prepare("INSERT INTO schedule_entries (id, team_member_id, job_id, date, status) VALUES (?, ?, ?, ?, 'tentative')");
  for (const o of offsets) ins.run(`cr-${n++}`, memberId, jobId, D(o));
};
const dates = (jobId, memberId) => db.prepare(
  'SELECT date FROM schedule_entries WHERE job_id = ? AND team_member_id = ? ORDER BY date'
).all(jobId, memberId).map(r => r.date);
const call = async (method, p, body) => {
  const r = await fetch(`${baseUrl}/api/jobs${p}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

test('cancelling releases bookings from today on and keeps the past', async () => {
  book('j1', 'm1', [-2, -1, 0, 1, 2]);
  book('j1', 'e1', [-1, 0, 1]);
  db.prepare("INSERT INTO job_equipment (id, job_id, equipment_id) VALUES ('je1', 'j1', 'e1')").run();

  const preview = await call('GET', '/j1/future-bookings');
  assert.deepEqual(preview.body, { crew: 1, equipment: 1, days: 5 });

  const r = await call('POST', '/j1/status', { status: 'cancelled' });
  assert.equal(r.status, 200);
  assert.equal(r.body.job.status, 'cancelled');
  assert.deepEqual(r.body.released, { crew: 1, equipment: 1, days: 5 });
  assert.deepEqual(dates('j1', 'm1'), [D(-2), D(-1)]);
  assert.deepEqual(dates('j1', 'e1'), [D(-1)]);
  // The kit list survives so a reinstated job knows what it had
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM job_equipment WHERE job_id = 'j1'").get().c, 1);
});

test('released kit no longer clashes with another job', async () => {
  book('j1', 'e1', [3, 4]);
  db.prepare("INSERT INTO job_equipment (id, job_id, equipment_id) VALUES ('je1', 'j1', 'e1')").run();
  await call('POST', '/j1/status', { status: 'cancelled' });
  book('j2', 'm1', [3, 4]);
  const a = await call('POST', '/j2/equipment', { equipment_id: 'e1' });
  assert.deepEqual(a.body.conflicts, []);
});

test('cancelling through the full job update releases too', async () => {
  book('j1', 'm1', [1, 2]);
  const r = await call('PUT', '/j1', { status: 'cancelled' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.released, { crew: 1, equipment: 0, days: 2 });
  assert.deepEqual(dates('j1', 'm1'), []);
});

test('crew are notified before their days are released', async () => {
  book('j1', 'm2', [1]);
  await call('POST', '/j1/status', { status: 'cancelled' });
  const note = db.prepare("SELECT message FROM notifications WHERE team_member_id = 'm2'").get();
  assert.match(note.message, /cancelled/);
});

test('other status changes release nothing', async () => {
  book('j1', 'm1', [1, 2]);
  const r = await call('POST', '/j1/status', { status: 'planning' });
  assert.equal(r.body.released, undefined);
  assert.equal(dates('j1', 'm1').length, 2);
});
