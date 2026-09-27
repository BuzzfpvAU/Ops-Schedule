# Tracker Tag Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manage which Find My items the tracker follows, and which equipment each one is, from V2 Settings → Tracking — linked by the tag's permanent identifier instead of by name.

**Architecture:** A new `tracker_items` table on the server holds every item the Mac has keys for. Each sync run posts its inventory (no locations) to `POST /api/equipment/tracker/inventory`, gets back the included identifiers, locates only those, and pushes locations by `identifier`. Admins toggle and link items in a new Tags section of V2 Settings. DB logic lives in a small service module so routes stay thin and it can be unit-tested.

**Tech Stack:** Node 22 + Express + better-sqlite3 (`node:test`), React 18 + Vite (client-v2), Python 3.11 + FindMy 0.10.2 (`unittest`).

**Spec:** `docs/superpowers/specs/2026-09-27-tracker-tag-management-design.md`

## Global Constraints

- New items always start `included = 0`; only the name auto-link may include one.
- The inventory upsert never changes `included` or `equipment_id` on an existing row.
- If the inventory call fails, the tracker fetches **nothing** that run.
- The ingest key is never returned by any endpoint, and never committed.
- Legacy pushes with only `airtag_name` keep working unchanged.
- `tracker_stale_days` default 3, allowed 1–60.
- Name normalisation for auto-link: trim, lower-case, ’ and ‘ → '.
- Device classification: model starts with `iPhone`, `iPad`, `Mac`, `Watch`, `AirPods`, or identifier starts with `l:/` or `me:/` → `device`; else `tag`.
- Tracker tests use stdlib `unittest` (no pytest in the venv).
- Run all JS tests with `npm test` from the repo root.

---

## File map

| File | Responsibility |
|---|---|
| `server/src/db.js` (modify) | Create `tracker_items` and `app_settings` |
| `server/src/services/trackerItems.js` (create) | Inventory upsert + auto-link, stale-days setting, item status, list query |
| `server/src/routes/equipment.js` (modify) | Inventory endpoint, identifier path in `/locations`, admin item endpoints, status counts |
| `server/test/trackerItems.test.js` (create) | Service + route tests |
| `tracker/sync_airtags.py` (modify) | Classify, send inventory, fetch included only, push by identifier |
| `tracker/test_sync.py` (create) | Classification + inventory-failure tests |
| `client-v2/src/lib/tracker.js` (create) | Pure helpers: group/sort items, header counts |
| `client-v2/test/tracker.test.js` (create) | Tests for the helpers |
| `client-v2/src/api.js` (modify) | Tracker item API calls |
| `client-v2/src/components/TrackerTags.jsx` (create) | Tags section UI |
| `client-v2/src/components/Settings.jsx` (modify) | Mount Tags section, update setup copy |
| `client-v2/src/styles.css` (modify) | Row layout for the Tags list |

---

### Task 1: Server data model and tracker-items service

**Files:**
- Modify: `server/src/db.js` (after the `equipment_locations` block)
- Create: `server/src/services/trackerItems.js`
- Test: `server/test/trackerItems.test.js`

**Interfaces — Produces:**
- `normaliseTagName(name: string): string`
- `upsertInventory(db, items: Item[], nowIso: string): string[]` — included identifiers
- `getStaleDays(db): number`, `setStaleDays(db, days: number): number` (throws `RangeError` outside 1–60)
- `itemStatus(row, latestByAccount: Record<string,string>, staleDays: number, nowMs: number): string` — one of `missing`, `excluded`, `unlinked`, `waiting`, `stale`, `ok`
- `listItems(db, nowMs): { stale_days, items: Row[] }` — each row has all columns plus `equipment_name`, `status`

- [ ] **Step 1: Add tables to `server/src/db.js`** right after the `equipment_locations` `db.exec` block:

```js
  // Find My items the tracker Mac holds keys for (tags and Apple devices).
  // Keyed by the export's permanent identifier; linked to equipment by id.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracker_items (
      identifier TEXT PRIMARY KEY,
      account TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      emoji TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      serial_number TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'tag',
      included INTEGER NOT NULL DEFAULT 0,
      equipment_id TEXT,
      first_seen_at TEXT NOT NULL,
      last_inventory_at TEXT NOT NULL,
      last_seen_at TEXT,
      battery TEXT,
      FOREIGN KEY (equipment_id) REFERENCES team_members(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tracker_items_equipment
      ON tracker_items(equipment_id) WHERE equipment_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
```

- [ ] **Step 2: Write the failing service tests** in `server/test/trackerItems.test.js`:

```js
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
```

- [ ] **Step 3: Run to confirm failure**

Run: `node --test server/test/trackerItems.test.js`
Expected: FAIL — cannot find module `../src/services/trackerItems.js`.

- [ ] **Step 4: Implement `server/src/services/trackerItems.js`:**

```js
// Find My items the tracker Mac holds keys for, and how each maps to
// equipment. The Mac reports its inventory every run; admins choose what is
// tracked in V2 Settings. See docs/superpowers/specs/2026-09-27-tracker-tag-management-design.md.

const STALE_KEY = 'tracker_stale_days';
const DEFAULT_STALE_DAYS = 3;

export function normaliseTagName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/[‘’]/g, "'");
}

// Equipment an unlinked tag could adopt by name: active, not already linked,
// and the only equipment item with that normalised name.
function autoLinkTarget(db, name) {
  const wanted = normaliseTagName(name);
  if (!wanted) return null;
  const candidates = db.prepare(`
    SELECT tm.id, tm.airtag_name FROM team_members tm
    WHERE tm.is_equipment = 1 AND tm.active = 1 AND TRIM(COALESCE(tm.airtag_name, '')) != ''
      AND NOT EXISTS (SELECT 1 FROM tracker_items ti WHERE ti.equipment_id = tm.id)
  `).all().filter((r) => normaliseTagName(r.airtag_name) === wanted);
  const all = db.prepare(`
    SELECT airtag_name FROM team_members
    WHERE is_equipment = 1 AND active = 1 AND TRIM(COALESCE(airtag_name, '')) != ''
  `).all().filter((r) => normaliseTagName(r.airtag_name) === wanted);
  return candidates.length === 1 && all.length === 1 ? candidates[0].id : null;
}

export function upsertInventory(db, items, nowIso) {
  const find = db.prepare('SELECT identifier FROM tracker_items WHERE identifier = ?');
  const insert = db.prepare(`
    INSERT INTO tracker_items (identifier, account, name, emoji, model, serial_number, kind,
                               included, equipment_id, first_seen_at, last_inventory_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE tracker_items SET account = ?, name = ?, emoji = ?, model = ?, serial_number = ?,
                             kind = ?, last_inventory_at = ?
    WHERE identifier = ?
  `);
  db.transaction(() => {
    for (const it of items) {
      const identifier = String(it.identifier || '').trim();
      if (!identifier) continue;
      const kind = it.kind === 'device' ? 'device' : 'tag';
      const fields = [
        String(it.account || ''), String(it.name || ''), String(it.emoji || ''),
        String(it.model || ''), String(it.serial_number || ''), kind,
      ];
      if (find.get(identifier)) {
        update.run(...fields, nowIso, identifier);
      } else {
        const link = kind === 'tag' ? autoLinkTarget(db, it.name) : null;
        insert.run(identifier, ...fields, link ? 1 : 0, link, nowIso, nowIso);
      }
    }
  })();
  return db.prepare('SELECT identifier FROM tracker_items WHERE included = 1 ORDER BY identifier')
    .all().map((r) => r.identifier);
}

export function getStaleDays(db) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(STALE_KEY);
  const n = row ? parseInt(row.value, 10) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : DEFAULT_STALE_DAYS;
}

export function setStaleDays(db, days) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 60) throw new RangeError('stale_days must be a whole number from 1 to 60');
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(STALE_KEY, String(n));
  return n;
}

export function itemStatus(row, latestByAccount, staleDays, nowMs) {
  const latest = latestByAccount[row.account];
  if (latest && row.last_inventory_at < latest) return 'missing';
  if (!row.included) return 'excluded';
  if (!row.equipment_id) return 'unlinked';
  if (!row.last_seen_at) return 'waiting';
  const ageMs = nowMs - Date.parse(row.last_seen_at);
  if (ageMs > staleDays * 86400000) return 'stale';
  return 'ok';
}

export function listItems(db, nowMs = Date.now()) {
  const staleDays = getStaleDays(db);
  const rows = db.prepare(`
    SELECT ti.*, tm.name AS equipment_name
    FROM tracker_items ti
    LEFT JOIN team_members tm ON tm.id = ti.equipment_id
    ORDER BY ti.account, ti.kind = 'device', ti.name COLLATE NOCASE, ti.identifier
  `).all();
  const latestByAccount = {};
  for (const r of rows) {
    if (!latestByAccount[r.account] || r.last_inventory_at > latestByAccount[r.account]) {
      latestByAccount[r.account] = r.last_inventory_at;
    }
  }
  return {
    stale_days: staleDays,
    items: rows.map((r) => ({ ...r, status: itemStatus(r, latestByAccount, staleDays, nowMs) })),
  };
}
```

- [ ] **Step 5: Run tests**

Run: `node --test server/test/trackerItems.test.js`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/db.js server/src/services/trackerItems.js server/test/trackerItems.test.js
git commit -m "feat(tracker): tracker_items table and inventory service"
```

---

### Task 2: Server routes

**Files:**
- Modify: `server/src/routes/equipment.js`
- Test: `server/test/trackerRoutes.test.js` (create)

**Interfaces — Consumes:** Task 1 exports. **Produces (HTTP):**
- `POST /api/equipment/tracker/inventory` (X-Ingest-Key) body `{ items }` → `200 { included: string[] }`
- `POST /api/equipment/locations` rows may carry `identifier`
- `GET /api/equipment/tracker/items` (admin) → `{ stale_days, items }`
- `PATCH /api/equipment/tracker/items/:identifier` (admin) body `{ included?, equipment_id?, move? }` → `200 item` | `409 { error, holder }`
- `DELETE /api/equipment/tracker/items/:identifier` (admin) → `200 { success: true }` | `409`
- `PUT /api/equipment/tracker/settings` (admin) body `{ stale_days }` → `200 { stale_days }` | `400`
- `GET /api/equipment/tracking-status` adds `tags_total`, `tags_tracked`, `tags_stale`, `devices_hidden`

- [ ] **Step 1: Write failing route tests** in `server/test/trackerRoutes.test.js`:

```js
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initDb } from '../src/db.js';
import { signToken } from '../src/middleware/auth.js';
import equipmentRoutes from '../src/routes/equipment.js';

let db, server, baseUrl, dbPath, admin, member;
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
  baseUrl = `http://127.0.0.1:${server.address().port}/api/equipment`;
});

after(() => {
  server?.close();
  db?.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.TRACKER_INGEST_KEY;
});

beforeEach(() => {
  process.env.TRACKER_INGEST_KEY = KEY;
  db.exec('DELETE FROM equipment_locations');
  db.exec('DELETE FROM tracker_items');
  db.exec('DELETE FROM app_settings');
  db.exec("DELETE FROM team_members WHERE id LIKE 'eq%' OR id LIKE 'm%'");
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m1','Alex',1,1)").run();
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m2','Sam',0,1)").run();
  const eq = db.prepare('INSERT INTO team_members (id, name, is_equipment, airtag_name, active) VALUES (?,?,1,?,1)');
  eq.run('eq1', 'Drone A', 'Drone A Tag');
  eq.run('eq2', 'Drone B', '');
  admin = `auth_token=${signToken('m1', true)}`;
  member = `auth_token=${signToken('m2', false)}`;
});

const ingest = (p, body, key = KEY) => fetch(`${baseUrl}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Key': key }, body: JSON.stringify(body),
});
const asAdmin = (p, method = 'GET', body, cookie = admin) => fetch(`${baseUrl}${p}`, {
  method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined,
});
const inv = (items) => ingest('/tracker/inventory', { items });
const tagItem = (identifier, name) => ({ identifier, account: 'droneops', name, kind: 'tag' });

test('inventory requires the ingest key', async () => {
  assert.equal((await ingest('/tracker/inventory', { items: [] }, 'wrong')).status, 401);
  assert.equal((await fetch(`${baseUrl}/tracker/inventory`, { method: 'POST' })).status, 401);
});

test('inventory returns included identifiers, auto-linking by name', async () => {
  const res = await inv([tagItem('t1', 'drone a tag'), tagItem('t2', 'Stranger')]);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).included, ['t1']);
});

test('inventory rejects a body without an items array', async () => {
  assert.equal((await ingest('/tracker/inventory', { nope: 1 })).status, 400);
});

test('a location by identifier lands on the linked equipment', async () => {
  await inv([tagItem('t1', 'Drone A Tag')]);
  const res = await ingest('/locations', { locations: [{ identifier: 't1', lat: -31.9, lng: 115.8, battery: 'Full', seen_at: '2026-09-27T01:00:00Z' }] });
  const body = await res.json();
  assert.equal(body.inserted, 1);
  const loc = db.prepare('SELECT team_member_id FROM equipment_locations').get();
  assert.equal(loc.team_member_id, 'eq1');
  const item = db.prepare("SELECT last_seen_at, battery FROM tracker_items WHERE identifier = 't1'").get();
  assert.deepEqual(item, { last_seen_at: '2026-09-27T01:00:00Z', battery: 'Full' });
});

test('included but unlinked stores last-seen only; excluded or unknown is unmatched', async () => {
  await inv([tagItem('t2', 'Stranger'), tagItem('t3', 'Other')]);
  db.prepare("UPDATE tracker_items SET included = 1 WHERE identifier = 't2'").run();
  const res = await ingest('/locations', { locations: [
    { identifier: 't2', lat: 1, lng: 1, seen_at: '2026-09-27T01:00:00Z' },
    { identifier: 't3', lat: 1, lng: 1 },
    { identifier: 'nope', lat: 1, lng: 1 },
  ] });
  const body = await res.json();
  assert.equal(body.inserted, 0);
  assert.equal(body.unmatched.length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM equipment_locations').get().c, 0);
  assert.equal(db.prepare("SELECT last_seen_at FROM tracker_items WHERE identifier = 't2'").get().last_seen_at, '2026-09-27T01:00:00Z');
});

test('legacy airtag_name pushes still work', async () => {
  const res = await ingest('/locations', { locations: [{ airtag_name: 'Drone A Tag', lat: 1, lng: 1 }] });
  assert.equal((await res.json()).inserted, 1);
});

test('admin lists items; non-admins cannot', async () => {
  await inv([tagItem('t1', 'Drone A Tag')]);
  const res = await asAdmin('/tracker/items');
  const body = await res.json();
  assert.equal(body.stale_days, 3);
  assert.equal(body.items[0].equipment_name, 'Drone A');
  assert.equal((await asAdmin('/tracker/items', 'GET', undefined, member)).status, 403);
});

test('PATCH links, and moving a held link needs move:true', async () => {
  await inv([tagItem('t1', 'Drone A Tag'), tagItem('t2', 'Stranger')]);
  let res = await asAdmin('/tracker/items/t2', 'PATCH', { equipment_id: 'eq1', included: true });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).holder.identifier, 't1');
  res = await asAdmin('/tracker/items/t2', 'PATCH', { equipment_id: 'eq1', included: true, move: true });
  assert.equal(res.status, 200);
  assert.equal(db.prepare("SELECT equipment_id FROM tracker_items WHERE identifier = 't1'").get().equipment_id, null);
  assert.equal(db.prepare("SELECT equipment_id FROM tracker_items WHERE identifier = 't2'").get().equipment_id, 'eq1');
  res = await asAdmin('/tracker/items/t2', 'PATCH', { equipment_id: null });
  assert.equal((await res.json()).equipment_id, null);
});

test('PATCH refuses equipment that does not exist', async () => {
  await inv([tagItem('t1', 'x')]);
  assert.equal((await asAdmin('/tracker/items/t1', 'PATCH', { equipment_id: 'm1' })).status, 400);
  assert.equal((await asAdmin('/tracker/items/zzz', 'PATCH', { included: true })).status, 404);
});

test('DELETE only removes items missing from the latest inventory', async () => {
  await inv([tagItem('t1', 'a'), tagItem('t2', 'b')]);
  assert.equal((await asAdmin('/tracker/items/t1', 'DELETE')).status, 409);
  db.prepare("UPDATE tracker_items SET last_inventory_at = '2000-01-01T00:00:00Z' WHERE identifier = 't1'").run();
  assert.equal((await asAdmin('/tracker/items/t1', 'DELETE')).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM tracker_items WHERE identifier = 't1'").get().c, 0);
});

test('stale days can be set within 1-60', async () => {
  assert.equal((await asAdmin('/tracker/settings', 'PUT', { stale_days: 90 })).status, 400);
  const res = await asAdmin('/tracker/settings', 'PUT', { stale_days: 5 });
  assert.deepEqual(await res.json(), { stale_days: 5 });
});

test('tracking-status counts tags and hidden devices', async () => {
  await inv([tagItem('t1', 'Drone A Tag'), tagItem('t2', 'b'),
    { identifier: 'd1', account: 'droneops', name: 'Mac', kind: 'device', model: 'Mac17,2' }]);
  const s = await (await asAdmin('/tracking-status')).json();
  assert.equal(s.tags_total, 2);
  assert.equal(s.tags_tracked, 1);
  assert.equal(s.tags_stale, 0);
  assert.equal(s.devices_hidden, 1);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --test server/test/trackerRoutes.test.js`
Expected: FAIL (404s from missing routes).

- [ ] **Step 3: Implement in `server/src/routes/equipment.js`.**

Add to the imports:

```js
import { upsertInventory, listItems, setStaleDays } from '../services/trackerItems.js';
```

Add to the `tracking-status` handler, before `res.json`:

```js
  const { items } = listItems(req.db);
  const tags = items.filter((i) => i.kind === 'tag');
```

and in its response object:

```js
    tags_total: tags.length,
    tags_tracked: tags.filter((i) => i.included && i.equipment_id).length,
    tags_stale: tags.filter((i) => i.status === 'stale').length,
    devices_hidden: items.filter((i) => i.kind === 'device' && !i.included).length,
```

In `POST /locations`, replace the `const member = resolveMember(req.db, item);` block with:

```js
      let member;
      if (item.identifier) {
        const ti = trackerItem.get(String(item.identifier));
        if (!ti || !ti.included) {
          unmatched.push({ identifier: item.identifier, airtag_name: item.airtag_name || null });
          continue;
        }
        const seen = item.seen_at || now;
        touchItem.run(seen, item.battery || null, ti.identifier, seen);
        member = ti.equipment_id
          ? req.db.prepare('SELECT * FROM team_members WHERE id = ? AND is_equipment = 1').get(ti.equipment_id)
          : null;
        if (!member) continue; // included but not linked: last-seen only
      } else {
        member = resolveMember(req.db, item);
      }
      if (!member) {
        unmatched.push({ member_id: item.member_id || null, airtag_name: item.airtag_name || null });
        continue;
      }
```

with these statements prepared next to `insertStmt`:

```js
  const trackerItem = req.db.prepare('SELECT identifier, included, equipment_id FROM tracker_items WHERE identifier = ?');
  const touchItem = req.db.prepare(`
    UPDATE tracker_items SET last_seen_at = ?, battery = COALESCE(?, battery)
    WHERE identifier = ? AND (last_seen_at IS NULL OR last_seen_at < ?)
  `);
```

Add the new routes before `// ── Booking index`:

```js
// ── Tracker items (Find My inventory from the tracker Mac) ──────────
// The Mac reports every item it holds keys for and gets back the ones an
// admin chose to track. It locates only those.
router.post('/tracker/inventory', (req, res) => {
  if (!ingestKeyMatches(req)) return res.status(401).json({ error: 'Valid X-Ingest-Key required' });
  const items = req.body?.items;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });
  res.json({ included: upsertInventory(req.db, items, new Date().toISOString()) });
});

router.get('/tracker/items', requireAuth, requireAdmin, (req, res) => {
  res.json(listItems(req.db));
});

router.patch('/tracker/items/:identifier', requireAuth, requireAdmin, (req, res) => {
  const db = req.db;
  const id = req.params.identifier;
  const item = db.prepare('SELECT * FROM tracker_items WHERE identifier = ?').get(id);
  if (!item) return res.status(404).json({ error: 'Unknown item' });
  const { included, equipment_id, move } = req.body || {};

  if (equipment_id !== undefined && equipment_id !== null) {
    const eq = db.prepare('SELECT id FROM team_members WHERE id = ? AND is_equipment = 1').get(equipment_id);
    if (!eq) return res.status(400).json({ error: 'Not an equipment item' });
    const holder = db.prepare('SELECT identifier, name FROM tracker_items WHERE equipment_id = ? AND identifier != ?')
      .get(equipment_id, id);
    if (holder && !move) return res.status(409).json({ error: 'Equipment already linked to another tag', holder });
    db.transaction(() => {
      if (holder) db.prepare('UPDATE tracker_items SET equipment_id = NULL WHERE identifier = ?').run(holder.identifier);
      db.prepare('UPDATE tracker_items SET equipment_id = ? WHERE identifier = ?').run(equipment_id, id);
    })();
  } else if (equipment_id === null) {
    db.prepare('UPDATE tracker_items SET equipment_id = NULL WHERE identifier = ?').run(id);
  }
  if (included !== undefined) {
    db.prepare('UPDATE tracker_items SET included = ? WHERE identifier = ?').run(included ? 1 : 0, id);
  }
  res.json(listItems(db).items.find((i) => i.identifier === id));
});

router.delete('/tracker/items/:identifier', requireAuth, requireAdmin, (req, res) => {
  const item = listItems(req.db).items.find((i) => i.identifier === req.params.identifier);
  if (!item) return res.status(404).json({ error: 'Unknown item' });
  if (item.status !== 'missing') {
    return res.status(409).json({ error: 'Only items missing from the latest export can be removed' });
  }
  req.db.prepare('DELETE FROM tracker_items WHERE identifier = ?').run(item.identifier);
  res.json({ success: true });
});

router.put('/tracker/settings', requireAuth, requireAdmin, (req, res) => {
  try {
    res.json({ stale_days: setStaleDays(req.db, req.body?.stale_days) });
  } catch (e) {
    if (e instanceof RangeError) return res.status(400).json({ error: e.message });
    throw e;
  }
});
```

- [ ] **Step 4: Run tests**

Run: `node --test server/test/trackerRoutes.test.js server/test/trackingStatus.test.js`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/equipment.js server/test/trackerRoutes.test.js
git commit -m "feat(tracker): inventory, identifier pushes and admin item endpoints"
```

---

### Task 3: Tracker Mac — inventory first, locate included only

**Files:**
- Modify: `tracker/sync_airtags.py`
- Create: `tracker/test_sync.py`

**Interfaces — Consumes:** `POST /api/equipment/tracker/inventory` → `{ included }`; `/locations` rows with `identifier`.
**Produces:** `classify(model, identifier) -> "tag" | "device"`; `load_account(acct_dir) -> (account, [(accessory, meta_dict)])`; `inventory_rows(slug, pairs) -> list[dict]`; `post_inventory(rows) -> set[str] | None`.

- [ ] **Step 1: Write failing tests** in `tracker/test_sync.py`:

```python
import unittest
from unittest import mock

import sync_airtags as s


class Classify(unittest.TestCase):
    def test_tags(self):
        self.assertEqual(s.classify("", "2006~#00640403848084a0~#HGLJLL3SP0GV"), "tag")
        self.assertEqual(s.classify(None, "kmart-smart-tag-1"), "tag")

    def test_devices(self):
        self.assertEqual(s.classify("Mac17,2", "l:/00008142-001929502E22401C"), "device")
        self.assertEqual(s.classify("iPhone13,4", "me:/000332-10-abc"), "device")
        self.assertEqual(s.classify("iPad13,11", "x"), "device")
        self.assertEqual(s.classify("Watch6,1", "x"), "device")
        self.assertEqual(s.classify("AirPods3,1", "x"), "device")
        self.assertEqual(s.classify("", "l:/abc"), "device")


class InventoryRows(unittest.TestCase):
    def test_rows_carry_metadata(self):
        acc = mock.Mock(identifier="t1", model="", serial_number="SER")
        acc.name = "Grant’s Car"
        rows = s.inventory_rows("droneops", [(acc, {"emoji": "🚖"})])
        self.assertEqual(rows, [{
            "identifier": "t1", "account": "droneops", "name": "Grant’s Car", "emoji": "🚖",
            "model": "", "serial_number": "SER", "kind": "tag",
        }])


class InventoryFailure(unittest.TestCase):
    def test_failed_inventory_fetches_nothing(self):
        acc = mock.Mock(identifier="t1", model="", serial_number="")
        acc.name = "Tag"
        account = mock.Mock()
        with mock.patch.object(s, "INGEST_KEY", "k"), \
             mock.patch.object(s, "list_accounts", return_value=[mock.Mock(name_="x")]), \
             mock.patch.object(s, "load_account", return_value=(account, [(acc, {})])), \
             mock.patch.object(s, "post_inventory", return_value=None), \
             mock.patch.object(s, "push") as push:
            code = s.main([])
        account.fetch_location.assert_not_called()
        push.assert_not_called()
        self.assertEqual(code, 1)

    def test_only_included_are_fetched(self):
        a = mock.Mock(identifier="t1", model="", serial_number="")
        a.name = "A"
        b = mock.Mock(identifier="t2", model="", serial_number="")
        b.name = "B"
        account = mock.Mock()
        account.fetch_location.return_value = {}
        acct_dir = mock.Mock()
        acct_dir.name = "droneops"
        with mock.patch.object(s, "INGEST_KEY", "k"), \
             mock.patch.object(s, "list_accounts", return_value=[acct_dir]), \
             mock.patch.object(s, "load_account", return_value=(account, [(a, {}), (b, {})])), \
             mock.patch.object(s, "post_inventory", return_value={"t2"}), \
             mock.patch.object(s, "push", return_value=True):
            s.main([])
        account.fetch_location.assert_called_once_with([b])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd tracker && .venv/bin/python -m unittest test_sync -v`
Expected: FAIL — `module 'sync_airtags' has no attribute 'classify'`.

- [ ] **Step 3: Implement in `tracker/sync_airtags.py`.**

Add after `BATTERY`:

```python
DEVICE_MODEL_PREFIXES = ("iPhone", "iPad", "Mac", "Watch", "AirPods")


def classify(model: str | None, identifier: str | None) -> str:
    """'device' for Apple devices (never located unless an admin includes
    them), 'tag' for AirTags and third-party Find My tags."""
    if (model or "").startswith(DEVICE_MODEL_PREFIXES):
        return "device"
    if (identifier or "").startswith(("l:/", "me:/")):
        return "device"
    return "tag"
```

In `load_account`, keep each key file's JSON next to its accessory — replace the loop and return:

```python
    pairs = []
    for path in sorted(keys_dir.glob("*.json")):
        try:
            meta = json.loads(path.read_text())
            pairs.append((FindMyAccessory.from_json(path), meta))
        except Exception as exc:  # noqa: BLE001
            log.warning("[%s] skipping bad key file %s: %s", slug, path.name, exc)
    if not pairs:
        raise AccountError(
            f"[{slug}] no valid accessory keys in {keys_dir.name}/ — run "
            f"./export_keys.sh {slug} <apple-id-email>"
        )
    return account, pairs
```

(and update the docstring's return description to `(account, [(accessory, key_file_json)])`).

Add:

```python
def inventory_rows(slug: str, pairs) -> list[dict]:
    rows = []
    for acc, meta in pairs:
        ident = getattr(acc, "identifier", None)
        if not ident:
            continue
        model = getattr(acc, "model", None) or ""
        rows.append({
            "identifier": ident,
            "account": slug,
            "name": getattr(acc, "name", None) or "",
            "emoji": meta.get("emoji") or "",
            "model": model,
            "serial_number": getattr(acc, "serial_number", None) or "",
            "kind": classify(model, ident),
        })
    return rows


def post_inventory(rows: list[dict]) -> set[str] | None:
    """Report every held key; returns the identifiers to locate, or None on
    any failure (the caller must then locate nothing)."""
    req = urllib.request.Request(
        f"{API_URL}/api/equipment/tracker/inventory",
        data=json.dumps({"items": rows}).encode(),
        headers={"Content-Type": "application/json", "X-Ingest-Key": INGEST_KEY},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read())
        return set(body["included"])
    except urllib.error.HTTPError as exc:
        log.error("Inventory rejected (HTTP %s): %s", exc.code, exc.read()[:300])
    except Exception as exc:  # noqa: BLE001
        log.error("Inventory failed: %s", exc)
    return None
```

Change `fetch_account(acct_dir)` to `fetch_account(slug, account, accessories)`: drop its `load_account` call, and add `"identifier": getattr(accessory, "identifier", None),` to each location dict.

Replace `main`'s account loop with:

```python
    loaded = []
    failed = 0
    for acct_dir in acct_dirs:
        try:
            account, pairs = load_account(acct_dir)
        except AccountError as exc:
            log.error("%s", exc)
            failed += 1
            continue
        loaded.append((acct_dir.name, account, pairs))

    rows = [r for slug, _, pairs in loaded for r in inventory_rows(slug, pairs)]
    included = post_inventory(rows) if rows else set()
    if included is None:
        log.error("Inventory not accepted — locating nothing this run")
        return 1

    locations: list[dict] = []
    for slug, account, pairs in loaded:
        wanted = [acc for acc, _ in pairs if getattr(acc, "identifier", None) in included]
        log.info("[%s] %d of %d items included", slug, len(wanted), len(pairs))
        if wanted:
            locations.extend(fetch_account(slug, account, wanted))
```

Delete the duplicate-name warning loop (identifiers make names irrelevant); keep the `if not locations` / `push` / `failed` tail as it is.

- [ ] **Step 4: Run tests**

Run: `cd tracker && .venv/bin/python -m unittest test_sync -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Move excluded keys back** (exclusion now lives on the server):

```bash
cd tracker/accounts/droneops && mv excluded/* keys/ && rmdir excluded
```

- [ ] **Step 6: Commit**

```bash
git add tracker/sync_airtags.py tracker/test_sync.py
git commit -m "feat(tracker): report inventory first and locate only included items"
```

---

### Task 4: V2 Settings → Tags section

**Files:**
- Create: `client-v2/src/lib/tracker.js`, `client-v2/test/tracker.test.js`, `client-v2/src/components/TrackerTags.jsx`
- Modify: `client-v2/src/api.js`, `client-v2/src/components/Settings.jsx`, `client-v2/src/styles.css`

**Interfaces — Consumes:** Task 2 HTTP API. **Produces:** `groupItems(items) -> [{ account, tags, devices }]`; `headerCounts(items) -> { tags, tracked, stale, devicesHidden }`; `STATUS_LABEL`.

- [ ] **Step 1: Write failing tests** in `client-v2/test/tracker.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupItems, headerCounts, statusText } from '../src/lib/tracker.js';

const items = [
  { identifier: 'd1', account: 'droneops', kind: 'device', included: 0, status: 'excluded' },
  { identifier: 't1', account: 'droneops', kind: 'tag', included: 1, equipment_id: 'eq1', status: 'ok' },
  { identifier: 't2', account: 'droneops', kind: 'tag', included: 1, equipment_id: 'eq2', status: 'stale' },
  { identifier: 't3', account: 'site', kind: 'tag', included: 0, status: 'excluded' },
];

test('groupItems splits each account into tags and devices', () => {
  const g = groupItems(items);
  assert.deepEqual(g.map((x) => x.account), ['droneops', 'site']);
  assert.deepEqual(g[0].tags.map((i) => i.identifier), ['t1', 't2']);
  assert.deepEqual(g[0].devices.map((i) => i.identifier), ['d1']);
});

test('headerCounts', () => {
  assert.deepEqual(headerCounts(items), { tags: 3, tracked: 2, stale: 1, devicesHidden: 1 });
});

test('statusText', () => {
  assert.equal(statusText({ status: 'stale', last_seen_at: '2026-09-20T00:00:00Z' }, Date.parse('2026-09-25T00:00:00Z')), 'Stale · 5 days');
  assert.equal(statusText({ status: 'unlinked' }), 'Not linked');
  assert.equal(statusText({ status: 'ok', last_seen_at: '2026-09-25T00:00:00Z', battery: 'Full' }, Date.parse('2026-09-25T02:00:00Z')), 'Seen 2 h ago · Full');
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --test client-v2/test/tracker.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `client-v2/src/lib/tracker.js`:**

```js
// Pure helpers for the Settings → Tracking tag list.

export const STATUS_TONE = {
  missing: 'mute', excluded: 'mute', unlinked: 'warn', waiting: 'warn', stale: 'danger', ok: 'ok',
};

export function groupItems(items) {
  const byAccount = new Map();
  for (const it of items || []) {
    if (!byAccount.has(it.account)) byAccount.set(it.account, { account: it.account, tags: [], devices: [] });
    byAccount.get(it.account)[it.kind === 'device' ? 'devices' : 'tags'].push(it);
  }
  return [...byAccount.values()];
}

export function headerCounts(items) {
  const tags = (items || []).filter((i) => i.kind !== 'device');
  return {
    tags: tags.length,
    tracked: tags.filter((i) => i.included && i.equipment_id).length,
    stale: tags.filter((i) => i.status === 'stale').length,
    devicesHidden: (items || []).filter((i) => i.kind === 'device' && !i.included).length,
  };
}

function ageText(iso, nowMs) {
  const mins = Math.round((nowMs - Date.parse(iso)) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 90) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

export function statusText(item, nowMs = Date.now()) {
  switch (item.status) {
    case 'missing': return 'Missing from last export';
    case 'excluded': return 'Not included';
    case 'unlinked': return 'Not linked';
    case 'waiting': return 'Waiting for first report';
    case 'stale': {
      const days = Math.floor((nowMs - Date.parse(item.last_seen_at)) / 86400000);
      return `Stale · ${days} day${days === 1 ? '' : 's'}`;
    }
    default:
      return `Seen ${ageText(item.last_seen_at, nowMs)}${item.battery ? ` · ${item.battery}` : ''}`;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `node --test client-v2/test/tracker.test.js`
Expected: PASS.

- [ ] **Step 5: Add API calls** to `client-v2/src/api.js` under `// ── Equipment tracking (Find My) ──`:

```js
export const getTrackerItems = () => api('/equipment/tracker/items');
export const updateTrackerItem = (identifier, data) =>
  api(`/equipment/tracker/items/${encodeURIComponent(identifier)}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteTrackerItem = (identifier) =>
  api(`/equipment/tracker/items/${encodeURIComponent(identifier)}`, { method: 'DELETE' });
export const setTrackerStaleDays = (stale_days) =>
  api('/equipment/tracker/settings', { method: 'PUT', body: JSON.stringify({ stale_days }) });
```

- [ ] **Step 6: Create `client-v2/src/components/TrackerTags.jsx`:**

```jsx
import React, { useEffect, useState } from 'react';
import { Section } from './ui.jsx';
import {
  getTrackerItems, updateTrackerItem, deleteTrackerItem, setTrackerStaleDays, getEquipment,
} from '../api.js';
import { groupItems, headerCounts, statusText, STATUS_TONE } from '../lib/tracker.js';

// Every Find My item the tracker Mac holds keys for. Nothing is located
// until it is included here; tags are matched to equipment by their
// permanent identifier, so Find My names no longer matter.

function Row({ item, equipment, holders, onChange, onDelete, busy }) {
  const isDevice = item.kind === 'device';
  const toggle = (e) => {
    const on = e.target.checked;
    if (on && isDevice && !window.confirm(`This will track the location of ${item.name}, a personal device. Continue?`)) return;
    onChange(item, { included: on });
  };
  const link = (e) => {
    const equipment_id = e.target.value || null;
    const holder = equipment_id && holders.get(equipment_id);
    if (holder && holder.identifier !== item.identifier) {
      if (!window.confirm(`${holder.name} is linked to that equipment. Move the link to ${item.name}?`)) return;
      onChange(item, { equipment_id, move: true });
      return;
    }
    onChange(item, { equipment_id });
  };
  return (
    <div className={`tt-row${item.included ? '' : ' is-off'}`}>
      <label className="tt-name">
        <input type="checkbox" checked={!!item.included} onChange={toggle} disabled={busy} />
        <span className="tt-emoji">{item.emoji || (isDevice ? '💻' : '🏷')}</span>
        <span>
          <span className="entry-name">{item.name || item.identifier}</span>
          {isDevice && <span className="tag tag-mute" style={{ marginLeft: 6 }}>Apple device</span>}
          <span className="rl-sub tt-serial">{item.serial_number || item.model || item.identifier}</span>
        </span>
      </label>
      <select className="tt-link" value={item.equipment_id || ''} onChange={link} disabled={busy}>
        <option value="">Not linked</option>
        {equipment.map((eq) => {
          const holder = holders.get(eq.id);
          const other = holder && holder.identifier !== item.identifier;
          return (
            <option key={eq.id} value={eq.id}>
              {eq.name}{other ? ` (linked to ${holder.name})` : ''}
            </option>
          );
        })}
      </select>
      <span className={`tag tag-${STATUS_TONE[item.status] || 'mute'} tt-status`}>{statusText(item)}</span>
      {item.status === 'missing' && (
        <button className="btn btn-danger" disabled={busy} onClick={() => onDelete(item)}>Delete</button>
      )}
    </div>
  );
}

export default function TrackerTags({ showToast }) {
  const [data, setData] = useState(null);
  const [equipment, setEquipment] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [d, eq] = await Promise.all([getTrackerItems(), getEquipment()]);
      setData(d);
      setEquipment(eq.slice().sort((a, b) => a.name.localeCompare(b.name)));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => { load(); }, []);

  const run = async (fn, ok) => {
    setBusy(true);
    try {
      await fn();
      await load();
      showToast?.(ok, 'success');
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <Section title="Tags"><div className="banner banner-danger">{error}</div></Section>;
  if (!data) return <Section title="Tags"><div className="rl-sub">Loading…</div></Section>;

  const items = data.items;
  const counts = headerCounts(items);
  const holders = new Map(items.filter((i) => i.equipment_id).map((i) => [i.equipment_id, i]));
  const onChange = (item, patch) => run(() => updateTrackerItem(item.identifier, patch), `${item.name} updated — applies on the next sync`);
  const onDelete = (item) => run(() => deleteTrackerItem(item.identifier), `${item.name} removed`);

  return (
    <Section title="Tags">
      <div className="tt-head">
        <span>
          {counts.tags} tag{counts.tags === 1 ? '' : 's'} · {counts.tracked} tracked
          {counts.stale > 0 && <> · <strong className="tt-stale">{counts.stale} stale (&gt; {data.stale_days} days)</strong></>}
          {counts.devicesHidden > 0 && <> · {counts.devicesHidden} device{counts.devicesHidden === 1 ? '' : 's'} hidden</>}
        </span>
        <label className="tt-stale-input">
          Stale after
          <input
            type="number" min="1" max="60" defaultValue={data.stale_days} disabled={busy}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= 60) run(() => setTrackerStaleDays(n), `Stale after ${n} days`);
            }}
          />
          days
        </label>
      </div>

      {items.length === 0 && (
        <div className="banner banner-warn">
          Nothing reported yet. The list fills in after the tracker Mac&rsquo;s next sync.
        </div>
      )}

      {groupItems(items).map((g) => (
        <div key={g.account} className="tt-group">
          <div className="tt-account">{g.account}</div>
          {g.tags.map((it) => (
            <Row key={it.identifier} item={it} equipment={equipment} holders={holders}
              onChange={onChange} onDelete={onDelete} busy={busy} />
          ))}
          {g.devices.length > 0 && (
            <details className="tt-devices">
              <summary>{g.devices.length} Apple device{g.devices.length === 1 ? '' : 's'} — hidden</summary>
              {g.devices.map((it) => (
                <Row key={it.identifier} item={it} equipment={equipment} holders={holders}
                  onChange={onChange} onDelete={onDelete} busy={busy} />
              ))}
            </details>
          )}
        </div>
      ))}
    </Section>
  );
}
```

- [ ] **Step 7: Mount it in `Settings.jsx`** — import `TrackerTags from './TrackerTags.jsx'`, render `<TrackerTags showToast={showToast} />` directly before the existing `{locations && (<Section title="What is mapped">…)}` block, and delete that "What is mapped" block plus the now-unused `untagged/silent/reporting` memo and `getEquipmentLocations` load.

Update `STEPS` copy:
- Step 1 `cmd`: `'cd tracker\npython3.11 -m venv .venv\n.venv/bin/pip install \'findmy>=0.10.2\''`, and body adds: `FindMy 0.10.2 or newer — Apple refuses 0.10.1 sign-ins with a GSA 503.`
- "Export the accessory keys" body: `Asks for the Apple ID password, a 2FA method, the passcode of one of that Apple ID's devices (iPhone PIN or Mac login password), then an escrow password — choose "Generate a random password". Everything on the account is exported, phones and Macs included; nothing is located until you include it in Tags above.`
- "Point the tracker at this server" → title `Set the ingest key`, body `The server reads TRACKER_INGEST_KEY from a SetEnv line in its .htaccess. Generate one with openssl rand -hex 32; put the same value only in the installed launchd plist, never in the repo (it is public). .env holds just API_URL.`, cmd `openssl rand -hex 32\n# server .htaccess:  SetEnv TRACKER_INGEST_KEY <key>`
- "Poll every 20 minutes" body: `Copy the plist, set TRACKER_INGEST_KEY in the installed copy only, then load it.` and cmd adds `chmod 600 ~/Library/LaunchAgents/com.buzzbot.airtag-tracker.plist` before `launchctl load`.
- Replace "Name each tag in this app" with title `Include and link tags`, body `Each sync lists every item under Tags above. Tick the ones to track and pick the equipment each one is. Changes apply on the next sync.`, cmd `null`.
- In "Known limits", replace the "Matching is by name only…" item with `Items are matched by their permanent Find My identifier, so renaming a tag in Find My changes nothing here.`

- [ ] **Step 8: Styles** — append to `client-v2/src/styles.css`:

```css
/* Settings → Tracking: tag list */
.tt-head { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; font-size: 12.5px; margin-bottom: 10px; }
.tt-stale { color: var(--danger); font-weight: 600; }
.tt-stale-input { display: inline-flex; align-items: center; gap: 6px; color: var(--text-dim); }
.tt-stale-input input { width: 52px; }
.tt-group { margin-bottom: 14px; }
.tt-account { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-mute); margin: 6px 0; }
.tt-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto auto; gap: 8px; align-items: center; padding: 6px 0; border-top: 1px solid var(--line-soft); }
.tt-row.is-off .entry-name { color: var(--text-dim); }
.tt-name { display: flex; gap: 8px; align-items: center; min-width: 0; cursor: pointer; }
.tt-emoji { font-size: 16px; }
.tt-serial { display: block; font-size: 11px; }
.tt-status { white-space: nowrap; }
.tt-devices summary { cursor: pointer; font-size: 12px; color: var(--text-dim); padding: 6px 0; }
@media (max-width: 640px) {
  .tt-row { grid-template-columns: 1fr auto; }
  .tt-link { grid-column: 1 / -1; }
}
```

- [ ] **Step 9: Build and run all tests**

Run: `npm test && (cd client-v2 && npx vite build)`
Expected: all pass; build succeeds.

- [ ] **Step 10: Commit**

```bash
git add client-v2/src/lib/tracker.js client-v2/test/tracker.test.js client-v2/src/components/TrackerTags.jsx client-v2/src/components/Settings.jsx client-v2/src/api.js client-v2/src/styles.css
git commit -m "feat(v2): Tags section in Settings → Tracking"
```

---

### Task 5: Verify end to end

- [ ] **Step 1: Local** — start `api-scratch` (with `TRACKER_INGEST_KEY` set in its env) and `v2` from `.claude/launch.json`. Run the tracker against it:

```bash
cd tracker && API_URL=http://localhost:3001 TRACKER_INGEST_KEY=<scratch key> .venv/bin/python sync_airtags.py
```

Expected log: `Inventory` accepted, `0 of 8 items included`, no Find My fetches. Settings → Tracking lists 4 tags and "4 Apple devices — hidden". Include + link one tag; re-run; log shows `1 of 8 items included`.

- [ ] **Step 2: Mobile layout** — `resize_window` preset mobile; rows stack, no horizontal scroll.

- [ ] **Step 3: Production** — only after the new key is in the server's `.htaccess` and the branch is deployed: one manual sync with the key from the installed plist, check Settings → Tracking on taskz.id/v2, then `launchctl load ~/Library/LaunchAgents/com.buzzbot.airtag-tracker.plist`.
