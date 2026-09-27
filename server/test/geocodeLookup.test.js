import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initDb } from '../src/db.js';
import { signToken, requireAuth } from '../src/middleware/auth.js';
import geocodeRoutes, { setPlaceLookup } from '../src/routes/geocode.js';
import { geocodePlace } from '../src/services/geocodeSite.js';

let db, server, base, dbPath, cookie, calls;

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-')), 'test.db');
  process.env.DATABASE_PATH = dbPath;
  db = initDb();
  const app = express();
  app.use(cookieParser());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/geocode', requireAuth, geocodeRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/geocode`;
});

after(() => {
  setPlaceLookup(null);
  server?.close();
  db?.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM team_members WHERE id LIKE 'm%'");
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m1','Alex',0,1)").run();
  cookie = `auth_token=${signToken('m1', false)}`;
  calls = 0;
  setPlaceLookup(async (q) => { calls += 1; return q.toLowerCase().includes('hedland') ? { lat: -20.31, lng: 118.6, label: 'Port Hedland, Western Australia' } : null; });
});

const get = (q) => fetch(`${base}?q=${encodeURIComponent(q)}`, { headers: { cookie } });

test('finds a town and caches it', async () => {
  assert.deepEqual(await (await get('Port Hedland')).json(), { found: true, lat: -20.31, lng: 118.6, label: 'Port Hedland, Western Australia' });
  await get('  port hedland ');
  assert.equal(calls, 1);
});

test('not found, and bad queries', async () => {
  assert.deepEqual(await (await get('Nowhereville')).json(), { found: false });
  assert.equal((await get('')).status, 400);
  assert.equal((await get('x'.repeat(121))).status, 400);
});

test('limits uncached lookups to 30 a minute per user', async () => {
  for (let i = 0; i < 30; i++) assert.equal((await get(`town ${i}`)).status, 200);
  assert.equal((await get('town 31')).status, 429);
});

test('needs a signed-in user', async () => {
  assert.equal((await fetch(`${base}?q=perth`)).status, 401);
});

test('geocodePlace returns a label from Photon properties', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ features: [{ geometry: { coordinates: [118.6, -20.31] }, properties: { name: 'Port Hedland', state: 'Western Australia' } }] }) });
  assert.deepEqual(await geocodePlace('x', { fetchImpl }), { lat: -20.31, lng: 118.6, label: 'Port Hedland, Western Australia' });
});
