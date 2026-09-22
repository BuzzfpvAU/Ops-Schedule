import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { initDb } from '../src/db.js';
import teamRoutes from '../src/routes/teams.js';

let db, server, baseUrl, dbPath;
let currentUser;

const ADMIN = { memberId: 'm1', name: 'Alex', isAdmin: true, isViewer: false };
const MEMBER = { memberId: 'm2', name: 'Sam', isAdmin: false, isViewer: false };

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-')), 'test.db');
  process.env.DATABASE_PATH = dbPath;
  db = initDb();

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; req.user = currentUser; next(); });
  app.use('/api/team-members', teamRoutes);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  db?.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM team_members WHERE id IN ('m1','m2','eq1','eq2')");
  db.prepare("INSERT INTO team_members (id, name) VALUES ('m1', 'Alex')").run();
  db.prepare("INSERT INTO team_members (id, name) VALUES ('m2', 'Sam')").run();
  db.prepare(`INSERT INTO team_members (id, name, is_equipment, equipment_category, serial_number, active)
              VALUES ('eq1', 'M350 Alpha', 1, 'Drones', 'SN-1', 1)`).run();
  db.prepare(`INSERT INTO team_members (id, name, is_equipment, active) VALUES ('eq2', 'Retired Rig', 1, 0)`).run();
  currentUser = ADMIN;
});

const list = async (q = '') => (await fetch(`${baseUrl}/api/team-members/equipment${q}`)).json();
const update = (id, body) =>
  fetch(`${baseUrl}/api/team-members/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('the list hides deactivated equipment by default', async () => {
  const rows = await list();
  assert.deepEqual(rows.map((r) => r.name), ['M350 Alpha']);
});

test('deactivated equipment can be listed on request', async () => {
  const rows = await list('?include_inactive=1');
  assert.deepEqual(rows.map((r) => r.name).sort(), ['M350 Alpha', 'Retired Rig']);
  assert.equal(rows.find((r) => r.id === 'eq2').active, 0);
});

test('include_inactive also accepts true', async () => {
  assert.equal((await list('?include_inactive=true')).length, 2);
});

test('an item can be deactivated and brought back', async () => {
  assert.equal((await update('eq1', { active: false })).status, 200);
  assert.equal((await list()).length, 0, 'hidden once deactivated');
  assert.equal((await list('?include_inactive=1')).length, 2, 'still findable');

  assert.equal((await update('eq1', { active: true })).status, 200);
  assert.deepEqual((await list()).map((r) => r.name), ['M350 Alpha']);
});

test('an update that says nothing about active leaves it alone', async () => {
  await update('eq2', { name: 'Retired Rig II' });
  const rows = await list('?include_inactive=1');
  const eq2 = rows.find((r) => r.id === 'eq2');
  assert.equal(eq2.name, 'Retired Rig II');
  assert.equal(eq2.active, 0, 'still deactivated');
});

test('editing details does not disturb the other fields', async () => {
  const res = await update('eq1', {
    name: 'M350 Alpha II',
    equipment_category: 'Payloads',
    serial_number: 'SN-9',
    serviceable: false,
  });
  const body = await res.json();
  assert.equal(body.name, 'M350 Alpha II');
  assert.equal(body.equipment_category, 'Payloads');
  assert.equal(body.serial_number, 'SN-9');
  assert.equal(body.serviceable, 0);
  assert.equal(body.active, 1, 'untouched by an edit that never mentions it');
});

test('serviceable and active are independent', async () => {
  await update('eq1', { serviceable: false });
  let rows = await list();
  assert.equal(rows.length, 1, 'unserviceable kit is still in the register');
  assert.equal(rows[0].serviceable, 0);

  await update('eq1', { active: false });
  assert.equal((await list()).length, 0);
});

test('non-admins cannot change equipment', async () => {
  currentUser = MEMBER;
  assert.equal((await update('eq1', { active: false })).status, 403);
});

test('updating something that does not exist is a 404', async () => {
  assert.equal((await update('nope', { active: false })).status, 404);
});
