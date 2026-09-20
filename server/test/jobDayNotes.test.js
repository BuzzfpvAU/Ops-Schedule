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
  db.exec('DELETE FROM job_day_notes; DELETE FROM schedule_entries; DELETE FROM jobs;');
  db.exec("DELETE FROM team_members WHERE id IN ('m1','m2','m3','eq1')");
  db.prepare("INSERT INTO team_members (id, name) VALUES ('m1', 'Alex')").run();
  db.prepare("INSERT INTO team_members (id, name) VALUES ('m2', 'Sam')").run();
  db.prepare("INSERT INTO team_members (id, name) VALUES ('m3', 'Viewer')").run();
  db.prepare("INSERT INTO team_members (id, name, is_equipment) VALUES ('eq1', 'M350 Alpha', 1)").run();
  db.prepare("INSERT INTO jobs (id, code, name) VALUES ('j1', 'AU-1', 'Job One')").run();
  currentUser = ADMIN;
});

const post = (jobId, body) =>
  fetch(`${baseUrl}/api/jobs/${jobId}/day-notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const del = (noteId) =>
  fetch(`${baseUrl}/api/jobs/day-notes/${noteId}`, { method: 'DELETE' });

const planner = async () => (await fetch(`${baseUrl}/api/jobs/j1/planner`)).json();

test('a note is stored against the entity and day, with its author', async () => {
  const res = await post('j1', { entity_id: 'eq1', date: '2026-09-27', text: 'Dispatched to KTA, tracking 12345' });
  assert.equal(res.status, 200);
  const note = await res.json();
  assert.equal(note.entity_id, 'eq1');
  assert.equal(note.date, '2026-09-27');
  assert.equal(note.text, 'Dispatched to KTA, tracking 12345');
  assert.equal(note.author_name, 'Alex');
  assert.equal(note.entity_name, 'M350 Alpha');
  assert.equal(note.is_equipment, 1);
});

test('the log appends rather than overwriting', async () => {
  await post('j1', { entity_id: 'eq1', date: '2026-09-27', text: 'Dispatched to KTA' });
  await post('j1', { entity_id: 'eq1', date: '2026-09-29', text: 'Arrived KTA' });
  await post('j1', { entity_id: 'eq1', date: '2026-09-27', text: 'Tracking 12345' });

  const { day_notes } = await planner();
  assert.equal(day_notes.length, 3, 'all three survive');
  const onThe27th = day_notes.filter((n) => n.date === '2026-09-27');
  assert.equal(onThe27th.length, 2, 'a day can carry several notes');
});

test('notes come back in date then creation order', async () => {
  await post('j1', { entity_id: 'eq1', date: '2026-09-29', text: 'Arrived' });
  await post('j1', { entity_id: 'eq1', date: '2026-09-27', text: 'Dispatched' });
  const { day_notes } = await planner();
  assert.deepEqual(day_notes.map((n) => n.text), ['Dispatched', 'Arrived']);
});

test('a note needs no booking on that day', async () => {
  // Nothing in schedule_entries at all — the kit is not rostered here.
  const res = await post('j1', { entity_id: 'eq1', date: '2026-12-01', text: 'Returned to depot' });
  assert.equal(res.status, 200);
  const { day_notes } = await planner();
  assert.equal(day_notes.length, 1);
});

test('empty or whitespace text is rejected', async () => {
  assert.equal((await post('j1', { entity_id: 'eq1', date: '2026-09-27', text: '' })).status, 400);
  assert.equal((await post('j1', { entity_id: 'eq1', date: '2026-09-27', text: '   ' })).status, 400);
});

test('text is trimmed', async () => {
  const note = await (await post('j1', { entity_id: 'eq1', date: '2026-09-27', text: '  Dispatched  ' })).json();
  assert.equal(note.text, 'Dispatched');
});

test('a malformed date is rejected', async () => {
  assert.equal((await post('j1', { entity_id: 'eq1', date: '27/09/2026', text: 'x' })).status, 400);
  assert.equal((await post('j1', { entity_id: 'eq1', date: 'tomorrow', text: 'x' })).status, 400);
});

test('an unknown job or entity is rejected', async () => {
  assert.equal((await post('nope', { entity_id: 'eq1', date: '2026-09-27', text: 'x' })).status, 404);
  assert.equal((await post('j1', { entity_id: 'nope', date: '2026-09-27', text: 'x' })).status, 404);
});

test('viewers cannot add notes', async () => {
  currentUser = VIEWER;
  assert.equal((await post('j1', { entity_id: 'eq1', date: '2026-09-27', text: 'x' })).status, 403);
});

test('an author can remove their own note', async () => {
  currentUser = MEMBER;
  const note = await (await post('j1', { entity_id: 'eq1', date: '2026-09-27', text: 'mine' })).json();
  assert.equal((await del(note.id)).status, 200);
  assert.equal((await planner()).day_notes.length, 0);
});

test('a member cannot remove someone else\'s note', async () => {
  currentUser = ADMIN;
  const note = await (await post('j1', { entity_id: 'eq1', date: '2026-09-27', text: 'admin note' })).json();
  currentUser = MEMBER;
  assert.equal((await del(note.id)).status, 403);
  currentUser = ADMIN;
  assert.equal((await planner()).day_notes.length, 1, 'the note survived the refused delete');
});

test('an admin can remove anyone\'s note', async () => {
  currentUser = MEMBER;
  const note = await (await post('j1', { entity_id: 'eq1', date: '2026-09-27', text: 'members note' })).json();
  currentUser = ADMIN;
  assert.equal((await del(note.id)).status, 200);
});

test('removing a note that does not exist is a 404, not a crash', async () => {
  assert.equal((await del('no-such-note')).status, 404);
});

test('notes follow the job and are removed with it', async () => {
  await post('j1', { entity_id: 'eq1', date: '2026-09-27', text: 'x' });
  db.prepare('DELETE FROM jobs WHERE id = ?').run('j1');
  const left = db.prepare('SELECT COUNT(*) AS c FROM job_day_notes').get();
  assert.equal(left.c, 0, 'cascade should clean them up');
});

test('notes are scoped to their job', async () => {
  db.prepare("INSERT INTO jobs (id, code, name) VALUES ('j2', 'AU-2', 'Job Two')").run();
  await post('j1', { entity_id: 'eq1', date: '2026-09-27', text: 'on job one' });
  await post('j2', { entity_id: 'eq1', date: '2026-09-27', text: 'on job two' });
  const { day_notes } = await planner();
  assert.equal(day_notes.length, 1);
  assert.equal(day_notes[0].text, 'on job one');
});
