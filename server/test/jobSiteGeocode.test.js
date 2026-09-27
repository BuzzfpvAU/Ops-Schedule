import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initDb } from '../src/db.js';
import { signToken, requireAuth } from '../src/middleware/auth.js';
import jobRoutes from '../src/routes/jobs.js';
import equipmentRoutes from '../src/routes/equipment.js';
import { setGeocoder, geocodeAddress } from '../src/services/geocodeSite.js';

let db, server, base, dbPath, cookie;
const settle = () => new Promise((r) => setTimeout(r, 30));

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-')), 'test.db');
  process.env.DATABASE_PATH = dbPath;
  db = initDb();
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/jobs', requireAuth, jobRoutes);
  app.use('/api/equipment', equipmentRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  setGeocoder(null);
  server?.close();
  db?.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM jobs');
  db.exec("DELETE FROM team_members WHERE id LIKE 'm%'");
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m1','Alex',1,1)").run();
  cookie = `auth_token=${signToken('m1', true)}`;
});

const call = (p, method = 'GET', body) => fetch(`${base}${p}`, {
  method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined,
});
const row = (id) => db.prepare('SELECT site_lat, site_lng, site_geocoded_address FROM jobs WHERE id = ?').get(id);

test('saving a site address stores its position after the response', async () => {
  const seen = [];
  setGeocoder(async (a) => { seen.push(a); return { lat: -32.26, lng: 150.89 }; });
  const job = await (await call('/jobs', 'POST', { code: 'G1', name: 'Geo', site_address: 'Muswellbrook NSW' })).json();
  await settle();
  assert.deepEqual(row(job.id), { site_lat: -32.26, site_lng: 150.89, site_geocoded_address: 'Muswellbrook NSW' });
  await call(`/jobs/${job.id}`, 'PUT', { site_address: 'Muswellbrook NSW' });
  await settle();
  assert.equal(seen.length, 1, 'unchanged address is not looked up again');
});

test('a failed lookup leaves no position; an emptied address clears it', async () => {
  setGeocoder(async () => null);
  const job = await (await call('/jobs', 'POST', { code: 'G2', name: 'Geo', site_address: 'Nowhere' })).json();
  await settle();
  assert.deepEqual(row(job.id), { site_lat: null, site_lng: null, site_geocoded_address: null });
  setGeocoder(async () => ({ lat: 1, lng: 2 }));
  await call(`/jobs/${job.id}`, 'PUT', { site_address: 'Somewhere' });
  await settle();
  assert.equal(row(job.id).site_lat, 1);
  await call(`/jobs/${job.id}`, 'PUT', { site_address: '' });
  await settle();
  assert.deepEqual(row(job.id), { site_lat: null, site_lng: null, site_geocoded_address: null });
});

test('a geocoder that throws never breaks the save', async () => {
  setGeocoder(async () => { throw new Error('down'); });
  const res = await call('/jobs', 'POST', { code: 'G3', name: 'Geo', site_address: 'X' });
  assert.equal(res.status, 201);
  await settle();
});

test('geocodeAddress parses Photon and returns null on errors', async () => {
  const ok = async () => ({ ok: true, json: async () => ({ features: [{ geometry: { coordinates: [150.89, -32.26] } }] }) });
  assert.deepEqual(await geocodeAddress('x', { fetchImpl: ok }), { lat: -32.26, lng: 150.89 });
  assert.equal(await geocodeAddress('x', { fetchImpl: async () => ({ ok: true, json: async () => ({ features: [] }) }) }), null);
  assert.equal(await geocodeAddress('x', { fetchImpl: async () => { throw new Error('net'); } }), null);
  assert.equal(await geocodeAddress('', { fetchImpl: ok }), null);
});

test('stale days are readable by any signed-in user', async () => {
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m2','Sam',0,1)").run();
  const res = await fetch(`${base}/equipment/tracker/stale-days`, { headers: { cookie: `auth_token=${signToken('m2', false)}` } });
  assert.deepEqual(await res.json(), { stale_days: 3 });
});
