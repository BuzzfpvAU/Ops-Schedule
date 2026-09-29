import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { initDb } from '../src/db.js';
import jobsRoutes from '../src/routes/jobs.js';

// Dragging on the timelines: a whole project, or one person's or item's run of days.

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
  db.prepare(`INSERT INTO jobs (id, code, name, planned_start, planned_end)
              VALUES ('j1', 'T1', 'Shift job', '2026-10-05', '2026-10-07')`).run();
  db.prepare("INSERT INTO jobs (id, code, name) VALUES ('j2', 'T2', 'Other job')").run();
});

let n = 0;
const book = (jobId, memberId, dates, status = 'tentative') => {
  const ins = db.prepare('INSERT INTO schedule_entries (id, team_member_id, job_id, date, status) VALUES (?, ?, ?, ?, ?)');
  for (const d of dates) ins.run(`dg-${n++}`, memberId, jobId, d, status);
};
const dates = (jobId, memberId) => db.prepare(
  'SELECT date FROM schedule_entries WHERE job_id = ? AND team_member_id = ? ORDER BY date'
).all(jobId, memberId).map(r => r.date);
const post = async (p, body) => {
  const r = await fetch(`${baseUrl}/api/jobs${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

test('dragging a project moves its planned dates and every booking', async () => {
  book('j1', 'm1', ['2026-10-05', '2026-10-06']);
  book('j1', 'e1', ['2026-10-04', '2026-10-08']);
  const r = await post('/j1/shift', { days: 3 });
  assert.equal(r.status, 200);
  assert.equal(r.body.job.planned_start, '2026-10-08');
  assert.equal(r.body.job.planned_end, '2026-10-10');
  assert.deepEqual(dates('j1', 'm1'), ['2026-10-08', '2026-10-09']);
  assert.deepEqual(dates('j1', 'e1'), ['2026-10-07', '2026-10-11']);
  assert.equal(r.body.members, 2);
});

test('a project without planned dates still moves its bookings', async () => {
  db.prepare("UPDATE jobs SET planned_start = '', planned_end = '' WHERE id = 'j1'").run();
  book('j1', 'm1', ['2026-10-05']);
  const r = await post('/j1/shift', { days: -2 });
  assert.equal(r.body.job.planned_start, '');
  assert.deepEqual(dates('j1', 'm1'), ['2026-10-03']);
});

test('project shift reports clashes and validates days', async () => {
  book('j1', 'm1', ['2026-10-05']);
  book('j2', 'm1', ['2026-10-12']);
  const r = await post('/j1/shift', { days: 7 });
  assert.equal(r.body.clashes.length, 1);
  assert.equal(r.body.clashes[0].job_code, 'T2');
  for (const days of [0, 1.5, 'x', 99999]) {
    assert.equal((await post('/j1/shift', { days })).status, 400, String(days));
  }
  assert.equal((await post('/nope/shift', { days: 1 })).status, 404);
});

test('dragging one bar moves only that run', async () => {
  book('j1', 'm1', ['2026-10-05', '2026-10-06', '2026-10-09']);
  book('j1', 'm2', ['2026-10-05']);
  const r = await post('/j1/bookings/shift', { member_id: 'm1', from: '2026-10-05', to: '2026-10-06', days: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(dates('j1', 'm1'), ['2026-10-06', '2026-10-07', '2026-10-09']);
  assert.deepEqual(dates('j1', 'm2'), ['2026-10-05']);
});

test('dragging an end lengthens with the same status, or shortens', async () => {
  book('j1', 'm1', ['2026-10-05', '2026-10-06', '2026-10-07'], 'confirmed');
  await post('/j1/bookings/shift', { member_id: 'm1', from: '2026-10-05', to: '2026-10-07', days: 2, edge: 'end' });
  assert.deepEqual(dates('j1', 'm1'), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
  assert.deepEqual(db.prepare("SELECT DISTINCT status FROM schedule_entries WHERE team_member_id = 'm1'").all(), [{ status: 'confirmed' }]);
  await post('/j1/bookings/shift', { member_id: 'm1', from: '2026-10-05', to: '2026-10-09', days: 2, edge: 'start' });
  assert.deepEqual(dates('j1', 'm1'), ['2026-10-07', '2026-10-08', '2026-10-09']);
  await post('/j1/bookings/shift', { member_id: 'm1', from: '2026-10-07', to: '2026-10-09', days: -1, edge: 'start' });
  assert.deepEqual(dates('j1', 'm1'), ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
});

test('shortening never removes the last day of a run', async () => {
  book('j1', 'm1', ['2026-10-05', '2026-10-06']);
  await post('/j1/bookings/shift', { member_id: 'm1', from: '2026-10-05', to: '2026-10-06', days: -9, edge: 'end' });
  assert.deepEqual(dates('j1', 'm1'), ['2026-10-05']);
});

test('booking shift validates its input', async () => {
  book('j1', 'm1', ['2026-10-05']);
  const ok = { member_id: 'm1', from: '2026-10-05', to: '2026-10-05', days: 1 };
  assert.equal((await post('/j1/bookings/shift', { ...ok, edge: 'middle' })).status, 400);
  assert.equal((await post('/j1/bookings/shift', { ...ok, from: 'bad' })).status, 400);
  assert.equal((await post('/j1/bookings/shift', { ...ok, days: 0 })).status, 400);
  assert.equal((await post('/j1/bookings/shift', { ...ok, from: '2026-11-01', to: '2026-11-02' })).status, 404);
});
