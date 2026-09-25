import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { initDb } from '../src/db.js';
import jobsRoutes from '../src/routes/jobs.js';

// Changing a job's planned dates on the card moves its bookings with it.

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
  for (const d of dates) ins.run(`se-${n++}`, memberId, jobId, d, status);
};
const dates = (jobId, memberId) => db.prepare(
  'SELECT date FROM schedule_entries WHERE job_id = ? AND team_member_id = ? ORDER BY date'
).all(jobId, memberId).map(r => r.date);
const put = async (body) => {
  const r = await fetch(`${baseUrl}/api/jobs/j1`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

test('moving the window shifts crew days by the same amount', async () => {
  book('j1', 'm1', ['2026-10-05', '2026-10-06', '2026-10-07'], 'confirmed');
  const r = await put({ planned_start: '2026-10-12', planned_end: '2026-10-14' });
  assert.equal(r.status, 200);
  assert.deepEqual(dates('j1', 'm1'), ['2026-10-12', '2026-10-13', '2026-10-14']);
  assert.equal(r.body.rebooked.members, 1);
  assert.deepEqual(r.body.rebooked.clashes, []);
  const statuses = db.prepare("SELECT DISTINCT status FROM schedule_entries WHERE job_id = 'j1'").all();
  assert.deepEqual(statuses, [{ status: 'confirmed' }]);
});

test('kit pads stay either side of the moved window', async () => {
  db.prepare("INSERT INTO job_equipment (id, job_id, equipment_id, pad_before, pad_after) VALUES ('je1','j1','e1',1,1)").run();
  book('j1', 'e1', ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
  await put({ planned_start: '2026-10-10', planned_end: '2026-10-11' }); // later and a day shorter
  assert.deepEqual(dates('j1', 'e1'), ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
});

test('a longer window extends people booked to the end, not partial bookings', async () => {
  book('j1', 'm1', ['2026-10-05', '2026-10-06', '2026-10-07']);
  book('j1', 'm2', ['2026-10-05']);
  await put({ planned_start: '2026-10-05', planned_end: '2026-10-09' });
  assert.deepEqual(dates('j1', 'm1'), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
  assert.deepEqual(dates('j1', 'm2'), ['2026-10-05']);
});

test('a shorter window drops the days that no longer fit', async () => {
  book('j1', 'm1', ['2026-10-05', '2026-10-06', '2026-10-07']);
  await put({ planned_start: '2026-10-05', planned_end: '2026-10-05' });
  assert.deepEqual(dates('j1', 'm1'), ['2026-10-05']);
});

test('moves anyway and reports clashes with other jobs', async () => {
  book('j1', 'm1', ['2026-10-05', '2026-10-06', '2026-10-07']);
  book('j2', 'm1', ['2026-10-13']);
  const r = await put({ planned_start: '2026-10-12', planned_end: '2026-10-14' });
  assert.deepEqual(dates('j1', 'm1'), ['2026-10-12', '2026-10-13', '2026-10-14']);
  assert.equal(r.body.rebooked.clashes.length, 1);
  assert.equal(r.body.rebooked.clashes[0].name, 'Alex');
  assert.equal(r.body.rebooked.clashes[0].job_code, 'T2');
  assert.deepEqual(dates('j2', 'm1'), ['2026-10-13']); // the other job is untouched
});

test('saving without a date change, or with no prior window, moves nothing', async () => {
  book('j1', 'm1', ['2026-10-05']);
  let r = await put({ name: 'Renamed', planned_start: '2026-10-05', planned_end: '2026-10-07' });
  assert.equal(r.body.rebooked, undefined);
  db.prepare("UPDATE jobs SET planned_start = '', planned_end = '' WHERE id = 'j1'").run();
  r = await put({ planned_start: '2026-11-01', planned_end: '2026-11-03' });
  assert.equal(r.body.rebooked, undefined);
  assert.deepEqual(dates('j1', 'm1'), ['2026-10-05']);
});
