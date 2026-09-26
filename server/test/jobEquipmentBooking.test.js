import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { initDb } from '../src/db.js';
import jobsRoutes from '../src/routes/jobs.js';

let db, server, baseUrl, dbPath;
let currentUser;

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-')), 'test.db');
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

beforeEach(() => {
  db.exec('DELETE FROM schedule_entries; DELETE FROM job_equipment; DELETE FROM jobs;');
  db.exec("DELETE FROM team_members WHERE id IN ('m1','e1')");
  db.prepare("INSERT INTO team_members (id, name) VALUES ('m1', 'Alex')").run();
  db.prepare("INSERT INTO team_members (id, name, is_equipment) VALUES ('e1', 'Mavic', 1)").run();
  db.prepare("INSERT INTO jobs (id, code, name) VALUES ('j1', 'T1', 'Booking job')").run();
  currentUser = { memberId: 'm1', isAdmin: true, isViewer: false };
});

const call = (method, p, body) => fetch(`${baseUrl}/api/jobs${p}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// Explicit 1-day pads: these tests are about how pads shape a booking, so
// they should not depend on the default (which is 0).
const assign = () => call('POST', '/j1/equipment', { equipment_id: 'e1', pad_before: 1, pad_after: 1 }).then(async r => ({
  status: r.status, body: await r.json(),
}));

test('migration is idempotent: re-init keeps assignments and bookings', async () => {
  seedRoster('j1', 'm1', ['2026-10-01', '2026-10-02']);
  const a = await assign();
  assert.equal(a.status, 201);

  db.close();
  db = initDb(); // second run must not drop/alter existing rows

  const card = await (await call('GET', '/j1')).json();
  assert.equal(card.equipment.length, 1);
  // Pads (±1 day) are part of the adopted booking
  assert.equal(card.equipment[0].booked_from, '2026-09-30');
  assert.equal(card.equipment[0].booked_to, '2026-10-03');
  assert.deepEqual(bookingDates('j1', 'e1'), ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03']);
});

const seedRoster = (jobId, memberId, dates) => {
  const ins = db.prepare(
    "INSERT INTO schedule_entries (id, team_member_id, job_id, date, status) VALUES (?, ?, ?, ?, 'tentative')"
  );
  dates.forEach((d, i) => ins.run(`${memberId}-${jobId}-${i}`, memberId, jobId, d));
};

const bookingDates = (jobId, memberId) => db.prepare(
  'SELECT date FROM schedule_entries WHERE job_id = ? AND team_member_id = ? ORDER BY date'
).all(jobId, memberId).map(r => r.date);

test('assigning equipment adopts the job timeframe plus buffer pads', async () => {
  seedRoster('j1', 'm1', ['2026-10-01', '2026-10-02', '2026-10-03']);
  const a = await assign();
  assert.equal(a.status, 201);
  // 1/1 pads → the 3-day span becomes a 5-day booking
  assert.equal(a.body.booked_days, 5);
  assert.deepEqual(bookingDates('j1', 'e1'),
    ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);

  const card = await (await call('GET', '/j1')).json();
  assert.equal(card.equipment[0].booked_from, '2026-09-30');
  assert.equal(card.equipment[0].booked_to, '2026-10-04');
  assert.equal(card.equipment[0].booked_days, 5);
});

test('with no pads given, equipment books exactly the job days', async () => {
  seedRoster('j1', 'm1', ['2026-10-01', '2026-10-02']);
  const res = await call('POST', '/j1/equipment', { equipment_id: 'e1' });
  const body = await res.json();
  assert.equal(body.pad_before, 0);
  assert.equal(body.pad_after, 0);
  assert.deepEqual(bookingDates('j1', 'e1'), ['2026-10-01', '2026-10-02']);
});

test('assigning to an unrostered job creates no booking', async () => {
  db.prepare("INSERT INTO jobs (id, code, name) VALUES ('j2', 'T2', 'Unrostered')").run();
  const res = await call('POST', '/j2/equipment', { equipment_id: 'e1' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.booked_days, 0);
  assert.deepEqual(bookingDates('j2', 'e1'), []);
});

test('booking + and - extend and trim each edge', async () => {
  seedRoster('j1', 'm1', ['2026-10-02']);
  const a = await assign();
  // pads: booking starts as 2026-10-01 → 2026-10-03
  const book = (edge, delta) => call('POST', `/equipment/${a.body.id}/booking`, { edge, delta });

  let r = await (await book('end', 1)).json();
  assert.deepEqual([r.booked_from, r.booked_to], ['2026-10-01', '2026-10-04']);
  r = await (await book('start', 1)).json();
  assert.deepEqual([r.booked_from, r.booked_to], ['2026-09-30', '2026-10-04']);
  r = await (await book('end', -1)).json();
  assert.deepEqual([r.booked_from, r.booked_to], ['2026-09-30', '2026-10-03']);
  r = await (await book('start', -1)).json();
  assert.deepEqual([r.booked_from, r.booked_to], ['2026-10-01', '2026-10-03']);
  assert.deepEqual(bookingDates('j1', 'e1'), ['2026-10-01', '2026-10-02', '2026-10-03']);
});

test('booking controls seed an empty booking from the job range', async () => {
  seedRoster('j1', 'm1', ['2026-10-01', '2026-10-02']);
  const a = await assign();
  // wipe the adopted booking to simulate an empty one
  db.prepare('DELETE FROM schedule_entries WHERE job_id = ? AND team_member_id = ?').run('j1', 'e1');
  const r = await (await call('POST', `/equipment/${a.body.id}/booking`, { edge: 'end', delta: 1 })).json();
  // job range adopted first (with ±1 pads), then extended one day past it
  assert.deepEqual([r.booked_from, r.booked_to], ['2026-09-30', '2026-10-04']);
});

test('booking endpoint validates edge, delta, id and admin', async () => {
  seedRoster('j1', 'm1', ['2026-10-02']);
  const a = await assign();
  const url = `/equipment/${a.body.id}/booking`;
  for (const body of [{ edge: 'middle', delta: 1 }, { edge: 'end', delta: 2 },
                      { edge: 'end', delta: 0 }, { edge: 'end' }]) {
    assert.equal((await call('POST', url, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call('POST', '/equipment/nope/booking', { edge: 'end', delta: 1 })).status, 404);
  currentUser = { memberId: 'm1', isAdmin: false, isViewer: false };
  assert.equal((await call('POST', url, { edge: 'end', delta: 1 })).status, 403);
});

test('unassigning equipment clears its booking entries', async () => {
  seedRoster('j1', 'm1', ['2026-10-01', '2026-10-02']);
  const a = await assign();
  assert.deepEqual(bookingDates('j1', 'e1').length, 4); // 2-day span + 1-day pads each side
  assert.equal((await call('DELETE', `/equipment/${a.body.id}`)).status, 200);
  assert.deepEqual(bookingDates('j1', 'e1'), []);
  // crew roster untouched
  assert.deepEqual(bookingDates('j1', 'm1'), ['2026-10-01', '2026-10-02']);
});

test('existing add/remove equipment flow still works', async () => {
  const a = await assign();
  assert.equal(a.status, 201);

  const dup = await assign();
  assert.equal(dup.status, 409);

  const del = await call('DELETE', `/equipment/${a.body.id}`);
  assert.equal(del.status, 200);
  const del2 = await call('DELETE', `/equipment/${a.body.id}`);
  assert.equal(del2.status, 404);
});
