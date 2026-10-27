import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initDb } from '../src/db.js';
import { signToken, requireAuth } from '../src/middleware/auth.js';
import vocRoutes from '../src/routes/vocs.js';
import certRoutes from '../src/routes/certs.js';
import { getCategory, vocCertTypeId } from '../src/services/vocTemplates.js';
import { expiryFor, vocsDir, todayInSydney } from '../src/services/vocs.js';

let db, server, base, dbPath, admin, member, other;

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-')), 'test.db');
  process.env.DATABASE_PATH = dbPath;
  db = initDb();
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/vocs', requireAuth, vocRoutes);
  app.use('/api/certs', requireAuth, certRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server?.close();
  db?.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM voc_assessments; DELETE FROM voc_equipment; DELETE FROM member_certs;');
  db.exec("DELETE FROM team_members WHERE id IN ('m1','m2','m3','d1')");
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m1','Alex Assessor',1,1)").run();
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m2','Sam Pilot',0,1)").run();
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m3','Jo Other',0,1)").run();
  db.prepare("INSERT INTO team_members (id, name, is_equipment, active) VALUES ('d1','DJI M350',1,1)").run();
  admin = `auth_token=${signToken('m1', true)}`;
  member = `auth_token=${signToken('m2', false)}`;
  other = `auth_token=${signToken('m3', false)}`;
});

const call = (url, method, body, cookie = admin) => fetch(`${base}${url}`, {
  method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body),
});

// A category result with every task marked the same way.
function result(key, { equipment = ['DJI M350 RTK'], task = 'competent', theory = 'pass', practical = 'pass', notes = '' } = {}) {
  const tasks = Object.fromEntries(getCategory(key).tasks.map((t) => [t.key, task]));
  return { key, equipment, tasks, theory, practical, theory_score: 90, notes };
}

const submission = (overrides = {}) => ({
  member_id: 'm2',
  assessed_on: '2026-03-10',
  assessor_name: 'Alex Assessor',
  results: [result('large-multirotor'), result('payload', { equipment: ['Zenmuse L2', 'Zenmuse P1'] })],
  ...overrides,
});

test('expiry is one year on, to the day', () => {
  assert.equal(expiryFor('2026-03-10'), '2027-03-10');
  assert.equal(expiryFor('2028-02-29'), '2029-02-28');
});

test('an admin records a VOC; it gets a certificate number and a PDF', async () => {
  const res = await call('/vocs', 'POST', submission());
  assert.equal(res.status, 201);
  const saved = await res.json();
  assert.equal(saved.cert_number, 'VOC-0001');
  assert.equal(saved.assessed_on, '2026-03-10');
  assert.equal(saved.expires_on, '2027-03-10');
  assert.deepEqual(saved.results.map((r) => [r.key, r.outcome]), [['large-multirotor', 'competent'], ['payload', 'competent']]);

  const second = await (await call('/vocs', 'POST', submission())).json();
  assert.equal(second.cert_number, 'VOC-0002');

  const pdf = await fetch(`${base}/vocs/${saved.id}/pdf?download=1`, { headers: { cookie: admin } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), /attachment; filename="AUAV_VOC_Sam-Pilot_VOC-0001_2026-03-10\.pdf"/);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.ok(fs.existsSync(path.join(vocsDir(db), `${saved.id}-v1.pdf`)), 'the certificate is kept on file');
});

test('only admins can record a VOC', async () => {
  const res = await call('/vocs', 'POST', submission(), member);
  assert.equal(res.status, 403);
});

test('team members can see and download only their own VOCs', async () => {
  const saved = await (await call('/vocs', 'POST', submission())).json();
  let res = await call('/vocs?member_id=m2', 'GET', null, member);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).length, 1);
  res = await fetch(`${base}/vocs/${saved.id}/pdf`, { headers: { cookie: member } });
  assert.equal(res.status, 200);

  res = await call('/vocs?member_id=m2', 'GET', null, other);
  assert.equal(res.status, 403);
  res = await fetch(`${base}/vocs/${saved.id}/pdf`, { headers: { cookie: other } });
  assert.equal(res.status, 404);
});

test('every task, theory and practical result and the equipment are required', async () => {
  const missing = result('small-multirotor', { equipment: [] });
  delete missing.tasks.planning;
  delete missing.theory;
  const res = await call('/vocs', 'POST', submission({ results: [missing] }));
  assert.equal(res.status, 400);
  const { errors } = await res.json();
  assert.ok(errors.some((e) => /add the aircraft assessed/.test(e)));
  assert.ok(errors.some((e) => /Flight planning/.test(e)));
  assert.ok(errors.some((e) => /theory result/.test(e)));

  const none = await call('/vocs', 'POST', submission({ results: [] }));
  assert.match((await none.json()).error, /at least one category/);
});

test('the date cannot be in the future but can be back-dated', async () => {
  let res = await call('/vocs', 'POST', submission({ assessed_on: '2999-01-01' }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /future/);
  res = await call('/vocs', 'POST', submission({ assessed_on: '2026-02-30' }));
  assert.equal(res.status, 400);
  res = await call('/vocs', 'POST', submission({ assessed_on: '2024-06-01' }));
  assert.equal(res.status, 201);
  assert.equal((await res.json()).expires_on, '2025-06-01');
});

test('a not-yet-competent category needs notes and is not certified', async () => {
  const nyc = result('confined-space', { equipment: ['Elios 3'], practical: 'fail' });
  let res = await call('/vocs', 'POST', submission({ results: [result('payload'), nyc] }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /note what still needs/);

  nyc.notes = 'Repeat the rescue drill';
  res = await call('/vocs', 'POST', submission({ results: [result('payload'), nyc] }));
  assert.equal(res.status, 201);
  const saved = await res.json();
  assert.deepEqual(saved.results.map((r) => [r.key, r.outcome]), [['confined-space', 'nyc'], ['payload', 'competent']], 'kept in category order');

  const certs = db.prepare('SELECT cert_type_id FROM member_certs WHERE member_id = ?').all('m2').map((r) => r.cert_type_id);
  assert.deepEqual(certs, [vocCertTypeId('payload')]);
});

test('competent categories appear in Certificates with the latest expiry', async () => {
  await call('/vocs', 'POST', submission({ assessed_on: '2025-01-15' }));
  const later = await (await call('/vocs', 'POST', submission({ assessed_on: '2026-01-20', results: [result('payload')] }))).json();
  const held = () => Object.fromEntries(
    db.prepare('SELECT cert_type_id, expiry_date FROM member_certs WHERE member_id = ?').all('m2')
      .map((r) => [r.cert_type_id, r.expiry_date]),
  );
  assert.deepEqual(held(), {
    [vocCertTypeId('large-multirotor')]: '2026-01-15',
    [vocCertTypeId('payload')]: '2027-01-20',
  });

  // Deleting the later VOC falls back to the earlier one.
  await call(`/vocs/${later.id}`, 'DELETE');
  assert.equal(held()[vocCertTypeId('payload')], '2026-01-15');
});

test('an admin can change the date, which moves the expiry and rebuilds the PDF', async () => {
  const saved = await (await call('/vocs', 'POST', submission())).json();
  await fetch(`${base}/vocs/${saved.id}/pdf`, { headers: { cookie: admin } });

  let res = await call(`/vocs/${saved.id}`, 'PATCH', { assessed_on: '2025-11-03' }, member);
  assert.equal(res.status, 403);
  res = await call(`/vocs/${saved.id}`, 'PATCH', { assessed_on: '2999-11-03' });
  assert.equal(res.status, 400);

  res = await call(`/vocs/${saved.id}`, 'PATCH', { assessed_on: '2025-11-03' });
  assert.equal(res.status, 200);
  const moved = await res.json();
  assert.equal(moved.expires_on, '2026-11-03');
  assert.equal(db.prepare('SELECT pdf_file FROM voc_assessments WHERE id = ?').get(saved.id).pdf_file, null);
  assert.equal(
    db.prepare('SELECT expiry_date FROM member_certs WHERE member_id = ? AND cert_type_id = ?').get('m2', vocCertTypeId('payload')).expiry_date,
    '2026-11-03',
  );
  const pdf = await fetch(`${base}/vocs/${saved.id}/pdf`, { headers: { cookie: admin } });
  assert.match(pdf.headers.get('content-disposition'), /_2025-11-03\.pdf/);
});

test('equipment entered on a VOC is remembered for next time', async () => {
  await call('/vocs', 'POST', submission({
    results: [result('payload', { equipment: ['Zenmuse L2', ' zenmuse   l2 ', 'Zenmuse P1'] })],
  }));
  await call('/vocs', 'POST', submission({ results: [result('payload', { equipment: ['ZENMUSE L2'] })] }));
  const list = await (await call('/vocs/equipment', 'GET', null, member)).json();
  assert.deepEqual(list.payload.map((e) => e.name), ['Zenmuse L2', 'Zenmuse P1']);
  assert.deepEqual(list['confined-space'], []);

  const added = await call('/vocs/equipment', 'POST', { category_key: 'confined-space', name: 'Elios 3' });
  assert.equal(added.status, 201);
  const { id } = await added.json();
  await call(`/vocs/equipment/${id}`, 'DELETE');
  assert.deepEqual((await (await call('/vocs/equipment', 'GET')).json())['confined-space'], []);
});

test('saving the certificates drawer leaves VOC certificates alone', async () => {
  await call('/vocs', 'POST', submission({ results: [result('payload')] }));
  const res = await call('/certs/members/m2', 'PUT', {
    certs: [{ cert_type_id: 'cert-repl', expiry_date: '2027-01-01' }, { cert_type_id: vocCertTypeId('payload'), expiry_date: '2099-01-01' }],
  });
  assert.equal(res.status, 200);
  const rows = Object.fromEntries((await res.json()).map((r) => [r.cert_type_id, r.expiry_date]));
  assert.equal(rows['cert-repl'], '2027-01-01');
  assert.equal(rows[vocCertTypeId('payload')], '2027-03-10', 'the VOC expiry is not overwritten');

  const rename = await call(`/certs/types/${vocCertTypeId('payload')}`, 'PUT', { name: 'Something else' });
  assert.equal(rename.status, 409);
});

test('the date check uses the Sydney calendar day', () => {
  assert.equal(todayInSydney(new Date('2026-10-27T14:30:00Z')), '2026-10-28');
});
