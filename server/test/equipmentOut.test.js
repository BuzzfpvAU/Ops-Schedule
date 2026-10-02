import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { initDb } from '../src/db.js';
import scheduleRoutes from '../src/routes/schedule.js';

let db, server, baseUrl, dbPath;

// The route reads req.user; swap it per request instead of minting real JWTs
let currentUser;

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-')), 'test.db');
  process.env.DATABASE_PATH = dbPath;
  db = initDb();

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; req.user = currentUser; next(); });
  app.use('/api/schedule', scheduleRoutes);

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
  db.exec('DELETE FROM schedule_entries; DELETE FROM jobs;');
  db.exec("DELETE FROM team_members WHERE id IN ('m1','m2','eq1')");
  db.prepare("INSERT INTO team_members (id, name) VALUES ('m1', 'Alex')").run();
  db.prepare("INSERT INTO team_members (id, name) VALUES ('m2', 'Sam')").run();
  db.prepare("INSERT INTO team_members (id, name, is_equipment) VALUES ('eq1', 'M350 Alpha', 1)").run();
  currentUser = { memberId: 'm1', isAdmin: true, isViewer: false };
});


const out = (body) => fetch(`${baseUrl}/api/schedule/equipment-out`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const entries = () => db.prepare(
  "SELECT date, status FROM schedule_entries WHERE team_member_id = 'eq1' ORDER BY date"
).all();

test('books a kit item out for every day of the range with the note', async () => {
  const res = await out({ equipment_id: 'eq1', from: '2026-10-05', to: '2026-10-08', text: 'Annual service' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json().then((r) => [r.added, r.days]), [4, 4]);
  assert.deepEqual(entries().map((e) => e.date), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
  assert.ok(entries().every((e) => e.status === 'note'));
  assert.equal(db.prepare("SELECT name FROM jobs WHERE name = 'Annual service'").all().length, 1);
});

test('repeating a booking adds only the missing days', async () => {
  await out({ equipment_id: 'eq1', from: '2026-10-05', to: '2026-10-06', text: 'Annual service' });
  const res = await out({ equipment_id: 'eq1', from: '2026-10-05', to: '2026-10-07', text: 'Annual service' });
  assert.equal((await res.json()).added, 1);
  assert.equal(entries().length, 3);
});

test('only admins can book kit out', async () => {
  currentUser = { memberId: 'm2', isAdmin: false, isViewer: false };
  const res = await out({ equipment_id: 'eq1', from: '2026-10-05', to: '2026-10-05', text: 'x' });
  assert.equal(res.status, 403);
  assert.equal(entries().length, 0);
});

test('rejects people, bad ranges and missing notes', async () => {
  assert.equal((await out({ equipment_id: 'm2', from: '2026-10-05', to: '2026-10-05', text: 'x' })).status, 404);
  assert.equal((await out({ equipment_id: 'eq1', from: '2026-10-06', to: '2026-10-05', text: 'x' })).status, 400);
  assert.equal((await out({ equipment_id: 'eq1', from: '2026-10-05', to: '2026-10-05', text: '  ' })).status, 400);
  assert.equal((await out({ equipment_id: 'eq1', from: '2026-01-01', to: '2028-01-01', text: 'x' })).status, 400);
  assert.equal(entries().length, 0);
});
