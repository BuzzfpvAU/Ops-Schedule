import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initDb } from '../src/db.js';
import { signToken } from '../src/middleware/auth.js';
import equipmentRoutes from '../src/routes/equipment.js';

let db, server, base, dbPath, admin, member;
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
  base = `http://127.0.0.1:${server.address().port}/api/equipment`;
});

after(() => {
  server?.close();
  db?.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.TRACKER_INGEST_KEY;
  delete process.env.TRACKER_PORTAL_URL;
});

beforeEach(() => {
  process.env.TRACKER_INGEST_KEY = KEY;
  process.env.TRACKER_PORTAL_URL = 'https://tags.example.test';
  db.exec('DELETE FROM tracker_invites');
  db.exec('DELETE FROM app_settings');
  db.exec("DELETE FROM team_members WHERE id LIKE 'm%'");
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m1','Alex',1,1)").run();
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m2','Sam',0,1)").run();
  admin = `auth_token=${signToken('m1', true)}`;
  member = `auth_token=${signToken('m2', false)}`;
});

const call = (p, { method = 'GET', body, cookie, key } = {}) => fetch(`${base}${p}`, {
  method,
  headers: {
    'Content-Type': 'application/json',
    ...(cookie ? { cookie } : {}),
    ...(key ? { 'X-Ingest-Key': key } : {}),
  },
  body: body ? JSON.stringify(body) : undefined,
});
const create = async (label = 'Sam – WA') => (await call('/tracker/invites', { method: 'POST', body: { label }, cookie: admin })).json();
const tokenOf = (url) => url.split('/i/')[1];

test('admin creates an invite; only the hash is stored', async () => {
  const res = await call('/tracker/invites', { method: 'POST', body: { label: 'Sam – WA' }, cookie: admin });
  assert.equal(res.status, 201);
  const { id, url } = await res.json();
  assert.match(url, /^https:\/\/tags\.example\.test\/i\/[A-Za-z0-9_-]{43}$/);
  const row = db.prepare('SELECT * FROM tracker_invites WHERE id = ?').get(id);
  assert.equal(row.token_hash, crypto.createHash('sha256').update(tokenOf(url)).digest('hex'));
  assert.equal(JSON.stringify(row).includes(tokenOf(url)), false);
  assert.equal(row.attempts_left, 3);
  assert.equal(row.status, 'pending');
});

test('creating needs an admin, a label and a configured portal', async () => {
  assert.equal((await call('/tracker/invites', { method: 'POST', body: { label: 'x' }, cookie: member })).status, 403);
  assert.equal((await call('/tracker/invites', { method: 'POST', body: { label: '  ' }, cookie: admin })).status, 400);
  delete process.env.TRACKER_PORTAL_URL;
  assert.equal((await call('/tracker/invites', { method: 'POST', body: { label: 'x' }, cookie: admin })).status, 400);
});

test('list never exposes tokens and computes expiry', async () => {
  const { id } = await create();
  db.prepare("UPDATE tracker_invites SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);
  const list = await (await call('/tracker/invites', { cookie: admin })).json();
  assert.equal(list[0].status, 'expired');
  assert.equal('token_hash' in list[0], false);
});

test('check needs the ingest key and a live token', async () => {
  const { url, id } = await create();
  const token = tokenOf(url);
  assert.equal((await call('/tracker/invites/check', { method: 'POST', body: { token }, key: 'nope' })).status, 401);
  let r = await (await call('/tracker/invites/check', { method: 'POST', body: { token }, key: KEY })).json();
  assert.deepEqual(r, { ok: true, id, label: 'Sam – WA', attempts_left: 3 });
  r = await (await call('/tracker/invites/check', { method: 'POST', body: { token: 'wrong' }, key: KEY })).json();
  assert.deepEqual(r, { ok: false });
});

test('attempts count down; failure returns to pending until none are left', async () => {
  const { url, id } = await create();
  for (let i = 0; i < 3; i++) {
    assert.equal((await call(`/tracker/invites/${id}/attempt`, { method: 'POST', key: KEY })).status, 200);
    const s = await (await call(`/tracker/invites/${id}/failed`, { method: 'POST', body: { note: 'bad_password' }, key: KEY })).json();
    assert.equal(s.status, i < 2 ? 'pending' : 'failed');
  }
  const r = await (await call('/tracker/invites/check', { method: 'POST', body: { token: tokenOf(url) }, key: KEY })).json();
  assert.equal(r.ok, false);
  assert.equal((await call(`/tracker/invites/${id}/attempt`, { method: 'POST', key: KEY })).status, 409);
});

test('complete makes the link single-use', async () => {
  const { url, id } = await create();
  await call(`/tracker/invites/${id}/attempt`, { method: 'POST', key: KEY });
  const s = await (await call(`/tracker/invites/${id}/complete`, { method: 'POST', body: { tags_saved: 2 }, key: KEY })).json();
  assert.equal(s.status, 'done');
  const r = await (await call('/tracker/invites/check', { method: 'POST', body: { token: tokenOf(url) }, key: KEY })).json();
  assert.equal(r.ok, false);
  assert.equal(db.prepare('SELECT tags_saved FROM tracker_invites WHERE id = ?').get(id).tags_saved, 2);
});

test('cleanup-failed is recorded for the admin', async () => {
  const { id } = await create();
  await call(`/tracker/invites/${id}/attempt`, { method: 'POST', key: KEY });
  await call(`/tracker/invites/${id}/complete`, { method: 'POST', body: { tags_saved: 1 }, key: KEY });
  const s = await (await call(`/tracker/invites/${id}/cleanup-failed`, { method: 'POST', body: { note: 'bottle not found' }, key: KEY })).json();
  assert.equal(s.status, 'cleanup_needed');
});

test('admin can cancel a pending invite only', async () => {
  const { id } = await create();
  assert.equal((await call(`/tracker/invites/${id}`, { method: 'DELETE', cookie: admin })).status, 200);
  assert.equal((await call(`/tracker/invites/${id}`, { method: 'DELETE', cookie: admin })).status, 409);
});

test('portal status from the inventory call shows in tracking-status', async () => {
  await call('/tracker/inventory', { method: 'POST', body: { items: [], portal: { ok: true, version: '1' } }, key: KEY });
  const s = await (await call('/tracking-status', { cookie: admin })).json();
  assert.equal(s.portal_url, 'https://tags.example.test');
  assert.match(s.portal_last_ok_at, /^\d{4}-/);
});

test('an attempt the portal never finished frees the link after 30 minutes', async () => {
  const { id, url } = await create();
  const token = tokenOf(url);
  await call(`/tracker/invites/${id}/attempt`, { method: 'POST', key: KEY });
  const check = async () => (await call('/tracker/invites/check', { method: 'POST', body: { token }, key: KEY })).json();

  // Mid-attempt the link is held, so a second phone cannot start over it.
  assert.equal((await check()).ok, false);

  // The portal restarted and never reported back: 31 minutes on, it is usable again.
  const stale = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  db.prepare('UPDATE tracker_invites SET attempted_at = ? WHERE id = ?').run(stale, id);
  const r = await check();
  assert.equal(r.ok, true);
  assert.equal(r.attempts_left, 2);
  const row = db.prepare('SELECT status, note FROM tracker_invites WHERE id = ?').get(id);
  assert.deepEqual({ ...row }, { status: 'pending', note: 'attempt interrupted' });
  assert.equal((await call(`/tracker/invites/${id}/attempt`, { method: 'POST', key: KEY })).status, 200);
});

test('a stuck final attempt reads as failed, not in progress', async () => {
  const { id } = await create();
  db.prepare("UPDATE tracker_invites SET status = 'in_progress', attempts_left = 0, attempted_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 31 * 60 * 1000).toISOString(), id);
  const list = await (await call('/tracker/invites', { cookie: admin })).json();
  assert.equal(list.find((i) => i.id === id).status, 'failed');
});
