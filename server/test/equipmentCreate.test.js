import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initDb } from '../src/db.js';
import { signToken, requireAuth } from '../src/middleware/auth.js';
import teamRoutes from '../src/routes/teams.js';

let db, server, base, dbPath, admin, member;

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-')), 'test.db');
  process.env.DATABASE_PATH = dbPath;
  db = initDb();
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/team-members', requireAuth, teamRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/team-members`;
});

after(() => {
  server?.close();
  db?.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM team_members WHERE id LIKE 'm%' OR is_equipment = 1");
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m1','Alex',1,1)").run();
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m2','Sam',0,1)").run();
  admin = `auth_token=${signToken('m1', true)}`;
  member = `auth_token=${signToken('m2', false)}`;
});

const post = (body, cookie = admin) => fetch(base, {
  method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body),
});

test('an admin can add equipment with its details', async () => {
  const res = await post({
    name: 'Matrice 350 #3', is_equipment: 1, equipment_category: 'Drones', location: 'WA',
    serial_number: 'SN-1', contents: '1 x Controller', serviceable: true,
  });
  assert.equal(res.status, 201);
  const item = await res.json();
  assert.equal(item.is_equipment, 1);
  assert.deepEqual([item.name, item.equipment_category, item.location, item.serial_number, item.contents],
    ['Matrice 350 #3', 'Drones', 'WA', 'SN-1', '1 x Controller']);
});

test('a name is required', async () => {
  assert.equal((await post({ name: '   ', is_equipment: 1 })).status, 400);
});

test('a duplicate active equipment name is refused, ignoring case and spaces', async () => {
  assert.equal((await post({ name: 'Survey Kit A', is_equipment: 1 })).status, 201);
  const res = await post({ name: '  survey kit a ', is_equipment: 1 });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /already/i);
});

test('an inactive item with the same name does not block a new one', async () => {
  const old = await (await post({ name: 'Old Drone', is_equipment: 1 })).json();
  db.prepare('UPDATE team_members SET active = 0 WHERE id = ?').run(old.id);
  assert.equal((await post({ name: 'Old Drone', is_equipment: 1 })).status, 201);
});

test('people with the same name as equipment are unaffected', async () => {
  assert.equal((await post({ name: 'Alex', is_equipment: 1 })).status, 201, 'equipment may share a person’s name');
});

test('non-admins cannot add equipment', async () => {
  assert.equal((await post({ name: 'X', is_equipment: 1 }, member)).status, 403);
});
