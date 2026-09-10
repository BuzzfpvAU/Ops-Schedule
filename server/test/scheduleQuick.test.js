import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { initDb } from '../src/db.js';
import scheduleRoutes from '../src/routes/schedule.js';

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
  app.use('/api/schedule', scheduleRoutes);

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
  db.exec('DELETE FROM schedule_entries; DELETE FROM jobs;');
  db.exec("DELETE FROM team_members WHERE id IN ('m1','m2')");
  db.prepare("INSERT INTO team_members (id, name) VALUES ('m1', 'Alex')").run();
  db.prepare("INSERT INTO team_members (id, name) VALUES ('m2', 'Sam')").run();
  currentUser = { memberId: 'm1', isAdmin: false, isViewer: false };
});

const quick = (body) => fetch(`${baseUrl}/api/schedule/quick`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('a non-admin marks their own day and the job is created for them', async () => {
  const res = await quick({ date: '2026-09-10', status: 'toil' });
  assert.equal(res.status, 200);

  const entry = await res.json();
  assert.equal(entry.team_member_id, 'm1');
  assert.equal(entry.status, 'toil');
  assert.equal(entry.job_code, 'TOIL');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM schedule_entries').get().c, 1);
});

test('a second TOIL day reuses the job instead of duplicating it', async () => {
  await quick({ date: '2026-09-10', status: 'toil' });
  await quick({ date: '2026-09-11', status: 'toil' });

  assert.equal(db.prepare("SELECT COUNT(*) c FROM jobs WHERE code = 'TOIL'").get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM schedule_entries').get().c, 2);
});

test('repeating the same status on the same day does not stack entries', async () => {
  await quick({ date: '2026-09-10', status: 'leave' });
  await quick({ date: '2026-09-10', status: 'leave' });

  assert.equal(db.prepare('SELECT COUNT(*) c FROM schedule_entries').get().c, 1);
});

test('a note creates a job named after the text', async () => {
  const res = await quick({ date: '2026-09-10', status: 'note', text: 'CASA paperwork' });
  const entry = await res.json();

  assert.equal(entry.job_name, 'CASA paperwork');
  assert.equal(entry.job_code, 'NOTE-CASAPAPERW');
  assert.equal(entry.status, 'note');
});

test('the same note text on another day reuses the job', async () => {
  await quick({ date: '2026-09-10', status: 'note', text: 'CASA paperwork' });
  await quick({ date: '2026-09-11', status: 'note', text: 'CASA paperwork' });

  assert.equal(db.prepare('SELECT COUNT(*) c FROM jobs').get().c, 1);
});

test('a note without text is rejected', async () => {
  const res = await quick({ date: '2026-09-10', status: 'note', text: '  ' });
  assert.equal(res.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM jobs').get().c, 0);
});

test('a non-admin cannot write to someone else', async () => {
  const res = await quick({ date: '2026-09-10', status: 'toil', team_member_id: 'm2' });
  assert.equal(res.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM schedule_entries').get().c, 0);
});

test('an admin can write to someone else', async () => {
  currentUser = { memberId: 'm1', isAdmin: true, isViewer: false };
  const res = await quick({ date: '2026-09-10', status: 'leave', team_member_id: 'm2' });

  assert.equal(res.status, 200);
  assert.equal((await res.json()).team_member_id, 'm2');
});

test('statuses outside the allowed set are rejected', async () => {
  const res = await quick({ date: '2026-09-10', status: 'confirmed' });
  assert.equal(res.status, 403);
});

test('viewers cannot write at all', async () => {
  currentUser = { memberId: 'm1', isAdmin: false, isViewer: true };
  const res = await quick({ date: '2026-09-10', status: 'toil' });
  assert.equal(res.status, 403);
});

test('an unknown member is rejected', async () => {
  currentUser = { memberId: 'm1', isAdmin: true, isViewer: false };
  const res = await quick({ date: '2026-09-10', status: 'toil', team_member_id: 'nope' });
  assert.equal(res.status, 404);
});

test('a member may delete their own note entry', async () => {
  const entry = await (await quick({ date: '2026-09-10', status: 'toil' })).json();
  const res = await fetch(`${baseUrl}/api/schedule/${entry.id}`, { method: 'DELETE' });

  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM schedule_entries').get().c, 0);
});

test('a member may not delete work an admin assigned them', async () => {
  db.prepare("INSERT INTO jobs (id, code, name) VALUES ('j1', 'DR-1', 'Survey')").run();
  db.prepare(
    "INSERT INTO schedule_entries (id, team_member_id, job_id, date, status) VALUES ('s1', 'm1', 'j1', '2026-09-10', 'confirmed')"
  ).run();

  const res = await fetch(`${baseUrl}/api/schedule/s1`, { method: 'DELETE' });
  assert.equal(res.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM schedule_entries').get().c, 1);
});

test('a member may not delete another member entry', async () => {
  db.prepare("INSERT INTO jobs (id, code, name) VALUES ('j1', 'TOIL', 'TOIL')").run();
  db.prepare(
    "INSERT INTO schedule_entries (id, team_member_id, job_id, date, status) VALUES ('s2', 'm2', 'j1', '2026-09-10', 'toil')"
  ).run();

  const res = await fetch(`${baseUrl}/api/schedule/s2`, { method: 'DELETE' });
  assert.equal(res.status, 403);
});
