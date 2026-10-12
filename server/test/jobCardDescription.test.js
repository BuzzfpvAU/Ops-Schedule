import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { initDb } from '../src/db.js';
import jobRoutes from '../src/routes/jobs.js';

let db, server, baseUrl, dbPath;

// The routes read req.user; swap it per request instead of minting real JWTs
let currentUser;

const ADMIN = { memberId: 'm1', name: 'Alex', isAdmin: true, isViewer: false };
const MEMBER = { memberId: 'm2', name: 'Sam', isAdmin: false, isViewer: false };
const VIEWER = { memberId: 'm3', name: 'Viewer', isAdmin: false, isViewer: true };

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-')), 'test.db');
  process.env.DATABASE_PATH = dbPath;
  db = initDb();

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; req.user = currentUser; next(); });
  app.use('/api/jobs', jobRoutes);

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
  db.exec("DELETE FROM team_members WHERE id IN ('m1','eq1')");
  db.prepare("INSERT INTO team_members (id, name) VALUES ('m1', 'Alex')").run();
  db.prepare("INSERT INTO team_members (id, name, is_equipment, serial_number, description) VALUES ('eq1', 'M300 2B', 1, 'SN-1', 'Matrice 300 RTK, second airframe')").run();
  db.prepare("INSERT INTO jobs (id, code, name) VALUES ('j1', 'AU-1', 'Job One')").run();
  db.prepare("INSERT INTO job_equipment (id, job_id, equipment_id) VALUES ('je1', 'j1', 'eq1')").run();
  currentUser = ADMIN;
});

test('the job card lists each kit item with its asset name, serial and description (for the manifest)', async () => {
  const card = await (await fetch(`${baseUrl}/api/jobs/j1`)).json();
  assert.equal(card.equipment.length, 1);
  const [item] = card.equipment;
  assert.deepEqual([item.equipment_name, item.serial_number, item.description],
    ['M300 2B', 'SN-1', 'Matrice 300 RTK, second airframe']);
});
