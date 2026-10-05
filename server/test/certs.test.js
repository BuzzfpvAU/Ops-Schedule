import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { initDb } from '../src/db.js';
import certRoutes from '../src/routes/certs.js';

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
  app.use('/api/certs', certRoutes);

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
  db.exec('DELETE FROM member_certs; DELETE FROM job_required_certs; DELETE FROM jobs;');
  db.exec("DELETE FROM team_members WHERE id IN ('m1','m2')");
  db.prepare("INSERT INTO team_members (id, name) VALUES ('m1', 'Alex')").run();
  db.prepare("INSERT INTO team_members (id, name) VALUES ('m2', 'Sam')").run();
  db.prepare("INSERT INTO jobs (id, code, name) VALUES ('j1', 'AU-1', 'Job One')").run();
  currentUser = { memberId: 'm1', isAdmin: true, isViewer: false };
});


const call = (method, url, body) => fetch(`${baseUrl}/api/certs${url}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('the business list is seeded with the standard certificates', async () => {
  const types = await (await call('GET', '/types')).json();
  const names = types.map((t) => t.name);
  for (const n of ['Confined Space', 'Working at Heights', 'RePL', 'AROC', 'BOSIET', 'MSIC', 'ASIC']) {
    assert.ok(names.includes(n), n);
  }
});

test('admins add types; duplicates are refused; non-admins cannot', async () => {
  const res = await call('POST', '/types', { name: 'Drone Night Rating' });
  assert.equal(res.status, 201);
  assert.equal((await call('POST', '/types', { name: 'drone night rating' })).status, 409);
  const id = (await res.json()).id;
  assert.equal((await call('PUT', `/types/${id}`, { active: false })).status, 200);
  db.prepare('DELETE FROM cert_types WHERE id = ?').run(id);
  currentUser = { memberId: 'm2', isAdmin: false, isViewer: false };
  assert.equal((await call('POST', '/types', { name: 'Another' })).status, 403);
});

test('a person\'s certificates are replaced as a set, expired ones kept', async () => {
  await call('PUT', '/members/m2', { certs: [
    { cert_type_id: 'cert-msic', expiry_date: '2020-01-01' },
    { cert_type_id: 'cert-asic', expiry_date: null },
  ] });
  let held = await (await call('GET', '/members')).json();
  assert.equal(held.filter((h) => h.member_id === 'm2').length, 2);
  await call('PUT', '/members/m2', { certs: [{ cert_type_id: 'cert-asic', expiry_date: '2027-05-01' }] });
  held = (await (await call('GET', '/members')).json()).filter((h) => h.member_id === 'm2');
  assert.deepEqual(held.map((h) => [h.cert_type_id, h.expiry_date]), [['cert-asic', '2027-05-01']]);
});

test('certificate edits validate input and need an admin', async () => {
  assert.equal((await call('PUT', '/members/m2', { certs: [{ cert_type_id: 'nope' }] })).status, 404);
  assert.equal((await call('PUT', '/members/m2', { certs: [{ cert_type_id: 'cert-msic', expiry_date: '1/2/2027' }] })).status, 400);
  assert.equal((await call('PUT', '/members/ghost', { certs: [] })).status, 404);
  currentUser = { memberId: 'm2', isAdmin: false, isViewer: false };
  assert.equal((await call('PUT', '/members/m2', { certs: [] })).status, 403);
});

test('a job keeps its required certificates', async () => {
  const ok = await call('PUT', '/jobs/j1', { cert_type_ids: ['cert-msic', 'cert-asic', 'cert-msic'] });
  assert.equal(ok.status, 200);
  const got = await (await call('GET', '/jobs/j1')).json();
  assert.deepEqual([...got.cert_type_ids].sort(), ['cert-asic', 'cert-msic']);
  assert.equal((await call('PUT', '/jobs/ghost', { cert_type_ids: [] })).status, 404);
});

test('a certificate can be saved as never expiring, and cannot also carry a date', async () => {
  const ok = await call('PUT', '/members/m2', { certs: [{ cert_type_id: 'cert-asic', no_expiry: true }] });
  assert.equal(ok.status, 200);
  const held = (await (await call('GET', '/members')).json()).filter((h) => h.member_id === 'm2');
  assert.deepEqual(held.map((h) => [h.cert_type_id, h.expiry_date, h.no_expiry]), [['cert-asic', null, 1]]);
  const bad = await call('PUT', '/members/m2', { certs: [{ cert_type_id: 'cert-asic', no_expiry: true, expiry_date: '2027-01-01' }] });
  assert.equal(bad.status, 400);
});
