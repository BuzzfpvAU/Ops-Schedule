import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb } from '../src/db.js';
import {
  normaliseTagName, upsertInventory, getStaleDays, setStaleDays, itemStatus, listItems,
} from '../src/services/trackerItems.js';

let db, dbPath;

before(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-')), 'test.db');
  process.env.DATABASE_PATH = dbPath;
  db = initDb();
});

after(() => {
  db?.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM tracker_items');
  db.exec('DELETE FROM app_settings');
  db.exec("DELETE FROM team_members WHERE id LIKE 'eq%'");
  const eq = db.prepare('INSERT INTO team_members (id, name, is_equipment, airtag_name, active) VALUES (?,?,1,?,?)');
  eq.run('eq1', 'Drone A', 'Grant\'s Backpack', 1);   // straight apostrophe
  eq.run('eq2', 'Drone B', '', 1);
  eq.run('eq3', 'Case 1', 'Dup', 1);
  eq.run('eq4', 'Case 2', 'dup', 1);                   // ambiguous with eq3
});

const tag = (identifier, name, extra = {}) => ({
  identifier, account: 'droneops', name, emoji: '', model: '', serial_number: '', kind: 'tag', ...extra,
});

test('normaliseTagName folds case, trims and straightens apostrophes', () => {
  assert.equal(normaliseTagName('  Grant’s Car '), "grant's car");
  assert.equal(normaliseTagName('‘X’'), "'x'");
  assert.equal(normaliseTagName(null), '');
});

test('new items start excluded and unlinked', () => {
  const included = upsertInventory(db, [tag('t1', 'Nothing matches')], '2026-09-27T00:00:00Z');
  assert.deepEqual(included, []);
  const row = db.prepare('SELECT * FROM tracker_items WHERE identifier = ?').get('t1');
  assert.equal(row.included, 0);
  assert.equal(row.equipment_id, null);
  assert.equal(row.first_seen_at, '2026-09-27T00:00:00Z');
});

test('a new tag whose name matches one equipment item is linked and included', () => {
  const included = upsertInventory(db, [tag('t1', 'Grant’s Backpack')], '2026-09-27T00:00:00Z');
  assert.deepEqual(included, ['t1']);
  const row = db.prepare('SELECT * FROM tracker_items WHERE identifier = ?').get('t1');
  assert.equal(row.equipment_id, 'eq1');
  assert.equal(row.included, 1);
});

test('auto-link skips ambiguous names, devices and already-linked equipment', () => {
  upsertInventory(db, [tag('t1', 'Grant’s Backpack')], '2026-09-27T00:00:00Z');
  upsertInventory(db, [
    tag('t2', 'DUP'),
    tag('t3', "Grant's Backpack"),
    tag('d1', 'Grant’s Backpack', { kind: 'device', model: 'Mac17,2' }),
  ], '2026-09-27T01:00:00Z');
  const rows = Object.fromEntries(db.prepare('SELECT identifier, equipment_id, included FROM tracker_items').all()
    .map((r) => [r.identifier, r]));
  assert.equal(rows.t2.equipment_id, null, 'two equipment items normalise to "dup"');
  assert.equal(rows.t3.equipment_id, null, 'eq1 is already linked to t1');
  assert.equal(rows.d1.equipment_id, null, 'devices are never auto-linked');
  assert.equal(rows.d1.included, 0);
});

test('an update refreshes metadata but never included or equipment_id', () => {
  upsertInventory(db, [tag('t1', 'Old name')], '2026-09-27T00:00:00Z');
  db.prepare("UPDATE tracker_items SET included = 1, equipment_id = 'eq2' WHERE identifier = 't1'").run();
  const included = upsertInventory(db, [tag('t1', 'Grant’s Backpack', { emoji: '🎒' })], '2026-09-27T02:00:00Z');
  const row = db.prepare('SELECT * FROM tracker_items WHERE identifier = ?').get('t1');
  assert.equal(row.name, 'Grant’s Backpack');
  assert.equal(row.emoji, '🎒');
  assert.equal(row.equipment_id, 'eq2', 'not re-linked by name on update');
  assert.equal(row.first_seen_at, '2026-09-27T00:00:00Z');
  assert.equal(row.last_inventory_at, '2026-09-27T02:00:00Z');
  assert.deepEqual(included, ['t1']);
});

test('stale days default to 3 and are bounded', () => {
  assert.equal(getStaleDays(db), 3);
  assert.equal(setStaleDays(db, 7), 7);
  assert.equal(getStaleDays(db), 7);
  assert.throws(() => setStaleDays(db, 0), RangeError);
  assert.throws(() => setStaleDays(db, 61), RangeError);
});

test('itemStatus follows the first-match-wins table', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const latest = { droneops: '2026-09-27T11:40:00Z' };
  const base = { account: 'droneops', last_inventory_at: '2026-09-27T11:40:00Z', included: 1, equipment_id: 'eq1', last_seen_at: '2026-09-27T10:00:00Z' };
  assert.equal(itemStatus({ ...base, last_inventory_at: '2026-09-26T00:00:00Z' }, latest, 3, now), 'missing');
  assert.equal(itemStatus({ ...base, included: 0 }, latest, 3, now), 'excluded');
  assert.equal(itemStatus({ ...base, equipment_id: null }, latest, 3, now), 'unlinked');
  assert.equal(itemStatus({ ...base, last_seen_at: null }, latest, 3, now), 'waiting');
  assert.equal(itemStatus({ ...base, last_seen_at: '2026-09-23T00:00:00Z' }, latest, 3, now), 'stale');
  assert.equal(itemStatus(base, latest, 3, now), 'ok');
});

test('listItems returns equipment names and statuses, tags before devices', () => {
  upsertInventory(db, [
    tag('d1', 'Mac', { kind: 'device', model: 'Mac17,2' }),
    tag('t1', 'Grant’s Backpack'),
  ], '2026-09-27T00:00:00Z');
  const { stale_days, items } = listItems(db, Date.parse('2026-09-27T00:10:00Z'));
  assert.equal(stale_days, 3);
  assert.deepEqual(items.map((i) => i.identifier), ['t1', 'd1']);
  assert.equal(items[0].equipment_name, 'Drone A');
  assert.equal(items[0].status, 'waiting');
  assert.equal(items[1].status, 'excluded');
});
