import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initDb } from '../src/db.js';
import { signToken } from '../src/middleware/auth.js';
import equipmentRoutes from '../src/routes/equipment.js';

let db, server, baseUrl, dbPath;

// This router applies requireAuth itself, which verifies a real JWT cookie and
// re-reads the member from the database — so the test signs a genuine token
// rather than injecting req.user, and exercises the real path.
let cookie;

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-')), 'test.db');
  process.env.DATABASE_PATH = dbPath;
  db = initDb();

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/equipment', equipmentRoutes);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  db?.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.TRACKER_INGEST_KEY;
});

beforeEach(() => {
  db.exec('DELETE FROM equipment_locations');
  db.exec("DELETE FROM team_members WHERE id LIKE 'eq%' OR id LIKE 'm%'");
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m1','Alex',1,1)").run();
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m2','Sam',0,1)").run();
  db.prepare(`INSERT INTO team_members (id, name, is_equipment, airtag_name, active) VALUES ('eq1','Drone A',1,'Drone A Tag',1)`).run();
  db.prepare(`INSERT INTO team_members (id, name, is_equipment, airtag_name, active) VALUES ('eq2','Drone B',1,'',1)`).run();
  db.prepare(`INSERT INTO team_members (id, name, is_equipment, airtag_name, active) VALUES ('eq3','Retired',1,'Old Tag',0)`).run();
  cookie = `auth_token=${signToken('m1', true)}`;
  delete process.env.TRACKER_INGEST_KEY;
});

const get = () => fetch(`${baseUrl}/api/equipment/tracking-status`, { headers: { cookie } });
const status = async () => (await get()).json();

test('reports whether the server holds an ingest key, never the key itself', async () => {
  let s = await status();
  assert.equal(s.ingest_key_configured, false);
  assert.equal(JSON.stringify(s).includes('secret'), false);

  process.env.TRACKER_INGEST_KEY = 'a-secret-value';
  s = await status();
  assert.equal(s.ingest_key_configured, true);
  assert.equal(JSON.stringify(s).includes('a-secret-value'), false, 'the key must never be returned');
});

test('counts only active equipment', async () => {
  const s = await status();
  assert.equal(s.equipment_total, 2, 'the retired item is excluded');
  assert.equal(s.equipment_with_tag, 1, 'only Drone A has a tag name');
});

test('reports nothing received before the first ping', async () => {
  const s = await status();
  assert.equal(s.pings_total, 0);
  assert.equal(s.reporting_items, 0);
  assert.equal(s.last_seen_at, null);
});

test('summarises pings once they arrive', async () => {
  const ins = db.prepare(`INSERT INTO equipment_locations (id, team_member_id, lat, lng, seen_at) VALUES (?,?,?,?,?)`);
  ins.run('l1', 'eq1', -33.8, 151.2, '2026-09-20T01:00:00Z');
  ins.run('l2', 'eq1', -33.9, 151.3, '2026-09-21T02:00:00Z');
  const s = await status();
  assert.equal(s.pings_total, 2);
  assert.equal(s.reporting_items, 1, 'distinct items, not raw pings');
  assert.equal(s.last_seen_at, '2026-09-21T02:00:00Z');
});

test('non-admins cannot read the diagnostics', async () => {
  cookie = `auth_token=${signToken('m2', false)}`;
  assert.equal((await get()).status, 403);
});

test('an unauthenticated request is refused', async () => {
  const res = await fetch(`${baseUrl}/api/equipment/tracking-status`);
  assert.equal(res.status, 401);
});
