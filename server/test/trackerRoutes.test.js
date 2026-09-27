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

let db, server, baseUrl, dbPath, admin, member;
const KEY = 'test-ingest-key';

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
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/equipment`;
});

after(() => {
  server?.close();
  db?.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.TRACKER_INGEST_KEY;
});

beforeEach(() => {
  process.env.TRACKER_INGEST_KEY = KEY;
  db.exec('DELETE FROM equipment_locations');
  db.exec('DELETE FROM tracker_items');
  db.exec('DELETE FROM app_settings');
  db.exec("DELETE FROM team_members WHERE id LIKE 'eq%' OR id LIKE 'm%'");
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m1','Alex',1,1)").run();
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m2','Sam',0,1)").run();
  const eq = db.prepare('INSERT INTO team_members (id, name, is_equipment, airtag_name, active) VALUES (?,?,1,?,1)');
  eq.run('eq1', 'Drone A', 'Drone A Tag');
  eq.run('eq2', 'Drone B', '');
  admin = `auth_token=${signToken('m1', true)}`;
  member = `auth_token=${signToken('m2', false)}`;
});

const ingest = (p, body, key = KEY) => fetch(`${baseUrl}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Key': key }, body: JSON.stringify(body),
});
const asAdmin = (p, method = 'GET', body, cookie = admin) => fetch(`${baseUrl}${p}`, {
  method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined,
});
const inv = (items) => ingest('/tracker/inventory', { items });
const tagItem = (identifier, name) => ({ identifier, account: 'droneops', name, kind: 'tag' });

test('inventory requires the ingest key', async () => {
  assert.equal((await ingest('/tracker/inventory', { items: [] }, 'wrong')).status, 401);
  assert.equal((await fetch(`${baseUrl}/tracker/inventory`, { method: 'POST' })).status, 401);
});

test('inventory returns included identifiers, auto-linking by name', async () => {
  const res = await inv([tagItem('t1', 'drone a tag'), tagItem('t2', 'Stranger')]);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).included, ['t1']);
});

test('inventory rejects a body without an items array', async () => {
  assert.equal((await ingest('/tracker/inventory', { nope: 1 })).status, 400);
});

test('a location by identifier lands on the linked equipment', async () => {
  await inv([tagItem('t1', 'Drone A Tag')]);
  const res = await ingest('/locations', { locations: [{ identifier: 't1', lat: -31.9, lng: 115.8, battery: 'Full', seen_at: '2026-09-27T01:00:00Z' }] });
  const body = await res.json();
  assert.equal(body.inserted, 1);
  const loc = db.prepare('SELECT team_member_id FROM equipment_locations').get();
  assert.equal(loc.team_member_id, 'eq1');
  const item = db.prepare("SELECT last_seen_at, battery FROM tracker_items WHERE identifier = 't1'").get();
  assert.deepEqual(item, { last_seen_at: '2026-09-27T01:00:00Z', battery: 'Full' });
});

test('included but unlinked stores last-seen only; excluded or unknown is unmatched', async () => {
  await inv([tagItem('t2', 'Stranger'), tagItem('t3', 'Other')]);
  db.prepare("UPDATE tracker_items SET included = 1 WHERE identifier = 't2'").run();
  const res = await ingest('/locations', { locations: [
    { identifier: 't2', lat: 1, lng: 1, seen_at: '2026-09-27T01:00:00Z' },
    { identifier: 't3', lat: 1, lng: 1 },
    { identifier: 'nope', lat: 1, lng: 1 },
  ] });
  const body = await res.json();
  assert.equal(body.inserted, 0);
  assert.equal(body.unmatched.length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM equipment_locations').get().c, 0);
  assert.equal(db.prepare("SELECT last_seen_at FROM tracker_items WHERE identifier = 't2'").get().last_seen_at, '2026-09-27T01:00:00Z');
});

test('legacy airtag_name pushes still work', async () => {
  const res = await ingest('/locations', { locations: [{ airtag_name: 'Drone A Tag', lat: 1, lng: 1 }] });
  assert.equal((await res.json()).inserted, 1);
});

test('admin lists items; non-admins cannot', async () => {
  await inv([tagItem('t1', 'Drone A Tag')]);
  const res = await asAdmin('/tracker/items');
  const body = await res.json();
  assert.equal(body.stale_days, 3);
  assert.equal(body.items[0].equipment_name, 'Drone A');
  assert.equal((await asAdmin('/tracker/items', 'GET', undefined, member)).status, 403);
});

test('PATCH links, and moving a held link needs move:true', async () => {
  await inv([tagItem('t1', 'Drone A Tag'), tagItem('t2', 'Stranger')]);
  let res = await asAdmin('/tracker/items/t2', 'PATCH', { equipment_id: 'eq1', included: true });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).holder.identifier, 't1');
  res = await asAdmin('/tracker/items/t2', 'PATCH', { equipment_id: 'eq1', included: true, move: true });
  assert.equal(res.status, 200);
  assert.equal(db.prepare("SELECT equipment_id FROM tracker_items WHERE identifier = 't1'").get().equipment_id, null);
  assert.equal(db.prepare("SELECT equipment_id FROM tracker_items WHERE identifier = 't2'").get().equipment_id, 'eq1');
  res = await asAdmin('/tracker/items/t2', 'PATCH', { equipment_id: null });
  assert.equal((await res.json()).equipment_id, null);
});

test('PATCH refuses equipment that does not exist', async () => {
  await inv([tagItem('t1', 'x')]);
  assert.equal((await asAdmin('/tracker/items/t1', 'PATCH', { equipment_id: 'm1' })).status, 400);
  assert.equal((await asAdmin('/tracker/items/zzz', 'PATCH', { included: true })).status, 404);
});

test('DELETE only removes items missing from the latest inventory', async () => {
  await inv([tagItem('t1', 'a'), tagItem('t2', 'b')]);
  assert.equal((await asAdmin('/tracker/items/t1', 'DELETE')).status, 409);
  db.prepare("UPDATE tracker_items SET last_inventory_at = '2000-01-01T00:00:00Z' WHERE identifier = 't1'").run();
  assert.equal((await asAdmin('/tracker/items/t1', 'DELETE')).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM tracker_items WHERE identifier = 't1'").get().c, 0);
});

test('stale days can be set within 1-60', async () => {
  assert.equal((await asAdmin('/tracker/settings', 'PUT', { stale_days: 90 })).status, 400);
  const res = await asAdmin('/tracker/settings', 'PUT', { stale_days: 5 });
  assert.deepEqual(await res.json(), { stale_days: 5 });
});

test('tracking-status counts tags and hidden devices', async () => {
  await inv([tagItem('t1', 'Drone A Tag'), tagItem('t2', 'b'),
    { identifier: 'd1', account: 'droneops', name: 'Mac', kind: 'device', model: 'Mac17,2' }]);
  const s = await (await asAdmin('/tracking-status')).json();
  assert.equal(s.tags_total, 2);
  assert.equal(s.tags_tracked, 1);
  assert.equal(s.tags_stale, 0);
  assert.equal(s.devices_hidden, 1);
});
