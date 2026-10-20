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

const put = (id, body, cookie = admin) => fetch(`${base}/${id}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body),
});

const post = (body, cookie = admin) => fetch(base, {
  method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body),
});

test('equipment can be flagged as dangerous goods with its UN numbers', async () => {
  const res = await post({ name: 'Battery case', is_equipment: 1, dangerous_goods: true, un_codes: ['un3480', '3481', 'UN3480'] });
  assert.equal(res.status, 201);
  const item = await res.json();
  assert.equal(item.dangerous_goods, 1);
  assert.equal(item.un_codes, 'UN3480,UN3481');
});

test('equipment is not dangerous goods unless flagged', async () => {
  const item = await (await post({ name: 'Tripod', is_equipment: 1 })).json();
  assert.equal(item.dangerous_goods, 0);
  assert.equal(item.un_codes, '');
});

test('a malformed UN number is refused', async () => {
  const res = await post({ name: 'Fuel', is_equipment: 1, dangerous_goods: true, un_codes: 'UN12' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /UN12/);
});

test('unticking dangerous goods clears the codes; other edits leave them alone', async () => {
  const item = await (await post({ name: 'Drone case', is_equipment: 1, dangerous_goods: true, un_codes: 'UN3481' })).json();

  const renamed = await (await put(item.id, { name: 'Drone case 2' })).json();
  assert.deepEqual([renamed.dangerous_goods, renamed.un_codes], [1, 'UN3481']);

  const cleared = await (await put(item.id, { dangerous_goods: false, un_codes: 'UN3481' })).json();
  assert.deepEqual([cleared.dangerous_goods, cleared.un_codes], [0, '']);
});
