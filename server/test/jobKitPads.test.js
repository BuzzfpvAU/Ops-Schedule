import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { initDb } from '../src/db.js';
import jobsRoutes from '../src/routes/jobs.js';

// Kit is booked around the job's own window plus per-item transit pads.

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

let n = 0;
const book = (jobId, memberId, dates) => {
  const ins = db.prepare("INSERT INTO schedule_entries (id, team_member_id, job_id, date, status) VALUES (?, ?, ?, ?, 'tentative')");
  for (const d of dates) ins.run(`kp-${n++}`, memberId, jobId, d);
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

test('kit is booked around the planned window with the pads asked for', async () => {
  const r = await call('POST', '/j1/equipment', { equipment_id: 'e1', pad_before: 2, pad_after: 1 });
  assert.equal(r.status, 201);
  assert.deepEqual(dates('j1', 'e1'), ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
});

test("a second item does not inherit the first item's pads", async () => {
  await call('POST', '/j1/equipment', { equipment_id: 'e1', pad_before: 3, pad_after: 3 });
  await call('POST', '/j1/equipment', { equipment_id: 'e2', pad_before: 0, pad_after: 0 });
  assert.deepEqual(dates('j1', 'e2'), ['2026-10-05', '2026-10-06', '2026-10-07']);
});

test('without planned dates, kit follows the crew roster', async () => {
  db.prepare("UPDATE jobs SET planned_start = '', planned_end = '' WHERE id = 'j1'").run();
  book('j1', 'm1', ['2026-11-02', '2026-11-03']);
  await call('POST', '/j1/equipment', { equipment_id: 'e1', pad_before: 1, pad_after: 0 });
  assert.deepEqual(dates('j1', 'e1'), ['2026-11-01', '2026-11-02', '2026-11-03']);
});

test('changing pads redraws the booking and reports clashes', async () => {
  const a = await call('POST', '/j1/equipment', { equipment_id: 'e1' });
  book('j2', 'e1', ['2026-10-02']);
  const r = await call('PUT', `/equipment/${a.body.id}/pads`, { pad_before: 3, pad_after: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.body.pad_before, 3);
  assert.equal(r.body.pad_after, 0);
  assert.deepEqual(dates('j1', 'e1'), ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
  assert.equal(r.body.conflicts.length, 1);
  assert.equal(r.body.conflicts[0].code, 'T2');
  const row = db.prepare('SELECT pad_before, pad_after FROM job_equipment WHERE id = ?').get(a.body.id);
  assert.deepEqual({ ...row }, { pad_before: 3, pad_after: 0 });
});

test('pads are clamped and must be whole days', async () => {
  const a = await call('POST', '/j1/equipment', { equipment_id: 'e1' });
  assert.equal((await call('PUT', `/equipment/${a.body.id}/pads`, { pad_before: 1.5 })).status, 400);
  const r = await call('PUT', `/equipment/${a.body.id}/pads`, { pad_before: -4, pad_after: 99 });
  assert.equal(r.body.pad_before, 0);
  assert.equal(r.body.pad_after, 30);
  assert.equal((await call('PUT', '/equipment/nope/pads', { pad_before: 1 })).status, 404);
});
