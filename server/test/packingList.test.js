import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { initDb } from '../src/db.js';
import teamRoutes from '../src/routes/teams.js';
import jobsRoutes from '../src/routes/jobs.js';

// The packing list is built from the job card: each item's box size,
// weight and contents have to be stored on the equipment and come back
// with the card.

let db, server, baseUrl, dbPath;

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-')), 'test.db');
  process.env.DATABASE_PATH = dbPath;
  db = initDb();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; req.user = { memberId: 'm1', isAdmin: true, isViewer: false }; next(); });
  app.use('/api/team-members', teamRoutes);
  app.use('/api/jobs', jobsRoutes);
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
  db.exec('DELETE FROM job_equipment; DELETE FROM jobs;');
  db.exec("DELETE FROM team_members WHERE id IN ('m1','e1')");
  db.prepare("INSERT INTO team_members (id, name) VALUES ('m1', 'Alex')").run();
  db.prepare("INSERT INTO team_members (id, name, is_equipment) VALUES ('e1', 'Scout Drone', 1)").run();
  db.prepare("INSERT INTO jobs (id, code, name, job_number) VALUES ('j1', 'T1', 'Inpex', 'TE-11965')").run();
});

const send = (method, url, body) => fetch(`${baseUrl}/api${url}`, {
  method, headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

test('box contents are saved on equipment and come back on the job card', async () => {
  const contents = '1 x Scout Di 137 Drone\n1 x Controller';
  const u = await send('PUT', '/team-members/e1', { dimensions: '62 × 45 × 30 cm', weight: '14.5 kg', contents });
  assert.equal(u.status, 200);
  assert.equal(u.body.contents, contents);

  await send('POST', '/jobs/j1/equipment', { equipment_id: 'e1' });
  const card = await send('GET', '/jobs/j1');
  const item = card.body.equipment[0];
  assert.equal(item.equipment_name, 'Scout Drone');
  assert.equal(item.dimensions, '62 × 45 × 30 cm');
  assert.equal(item.weight, '14.5 kg');
  assert.equal(item.contents, contents);
  assert.equal(card.body.job.job_number, 'TE-11965');
});

test('an update that leaves contents out keeps what was there', async () => {
  await send('PUT', '/team-members/e1', { contents: '1 x Kit Hardcase' });
  const u = await send('PUT', '/team-members/e1', { weight: '3 kg' });
  assert.equal(u.body.contents, '1 x Kit Hardcase');
});

test('new equipment can be created with contents', async () => {
  const r = await send('POST', '/team-members', { name: 'Ground Station', is_equipment: 1, contents: '1 x 50m Tether' });
  assert.equal(r.status, 201);
  assert.equal(r.body.contents, '1 x 50m Tether');
  db.prepare('DELETE FROM team_members WHERE id = ?').run(r.body.id);
});
