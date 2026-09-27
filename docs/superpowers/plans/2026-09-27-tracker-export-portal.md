# Tracker Export Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff with only a phone add their Find My tags through a one-time invite link to a portal on the tracker Mac, which runs export-findmy for them, keeps only the tags they tick, and cleans up everything else.

**Architecture:** taskz.id issues one-time invites (hash-stored) and tracks their lifecycle. A Python service on the Mac (`tracker/portal/`, stdlib HTTP + pexpect) validates the invite with taskz.id, drives export-findmy through a pty, saves chosen keys to `tracker/accounts/shared/<slug>/keys/`, reports them as excluded inventory, then deletes its escrow bottle and temp dir. The sync locates shared keys with the droneops session.

**Tech Stack:** Node 22/Express/better-sqlite3 (`node:test`), React (client-v2), Python 3.11 + pexpect (`unittest`), Cloudflare Tunnel (existing keyz.au tunnel).

**Spec:** `docs/superpowers/specs/2026-09-27-tracker-export-portal-design.md`

## Global Constraints

- Invite: 32 random bytes (base64url), stored only as SHA-256 hex; 24 h expiry; 3 attempts; single use.
- Password, 2FA code, passcode: never written to disk or logs; pexpect `logfile=None`.
- Portal binds `127.0.0.1:8765` only; public URL `https://tags.keyz.au`.
- One export session at a time. Idle 10 min → cleanup. Exporter silent 90 s → error `apple_unavailable`.
- Cleanup (bottle delete + temp dir removal) runs on every exit path.
- Kept keys: `tracker/accounts/shared/<slug>/keys/`, dirs 0700, files 0600; inventory `account = "shared/<slug>"`.
- Exporter pinned at `eb5a3a93116478e1c088dc90fa84e1bb30ee232e`; device profile name `Taskz Tag Export`, unique serial per session.
- Settings hides "Tracker Mac setup (admins)" when `TRACKER_PORTAL_URL` is set.
- JS tests: `npm test` at repo root. Python tests: `cd tracker && .venv/bin/python -m unittest discover -s portal/tests -t .` and `.venv/bin/python -m unittest test_sync`.

## Exporter prompt reference (export-findmy @ eb5a3a9, all on stderr)

| Prompt text (exact, trailing space) | Meaning |
|---|---|
| `Password: ` | Apple ID password (hidden input) |
| lines `  N - Trusted Device` / `  N - SMS (…)` then `Method [0]: ` | 2FA method |
| `Code: ` | 2FA code |
| lines `    [i] <desc>` then `  Choose bottle [0]: ` (only if >1) | which device's bottle to unlock with |
| `  Using escrow bottle from device: <desc> (serial S)` then `  Enter the passcode of that device: ` | device passcode |
| `  No accessories found!` then exit 0 | nothing on the account |
| `Done! Exported N accessory file pair(s)…` then exit 0 | success; files in `--output-dir` |
| `--delete-own-escrow-bottle`: `  [i] <desc>` + `      serial: S, build: …` lines, `Choose a bottle to delete, or press Enter to cancel: `, `Escrow password [press Enter to use the saved profile password]: `, `Type DELETE i to permanently delete this escrow bottle: `, `Final confirmation: type the device serial S: `, `Deleted escrow bottle: …` | cleanup |

With `EXPORT_FINDMY_ESCROW_PASSWORD` set, no escrow-password prompts appear during export. Apple's exact error strings for a wrong password/code/security key are not in the source; the driver classifies by pattern (see Task 3) and falls back to `unknown`. The manual E2E (Task 7) must record real strings and update the patterns.

---

## File map

| File | Responsibility |
|---|---|
| `server/src/services/trackerInvites.js` (create) | Invite create/list/check/lifecycle; portal status setting |
| `server/src/routes/equipment.js` (modify) | Invite endpoints; portal status in inventory + tracking-status |
| `server/test/trackerInvites.test.js` (create) | Server tests |
| `client-v2/src/lib/tracker.js` (modify) | `inviteStatusText`, `portalOnline` |
| `client-v2/test/tracker.test.js` (modify) | Helper tests |
| `client-v2/src/api.js` (modify) | Invite API calls |
| `client-v2/src/components/TrackerInvites.jsx` (create) | Invites UI |
| `client-v2/src/components/Settings.jsx` (modify) | Portal tile, Invites section, hide Mac setup |
| `tracker/portal/__init__.py` (create) | Package marker |
| `tracker/portal/exporter_driver.py` (create) | pexpect driver + bottle deletion |
| `tracker/portal/session.py` (create) | One export session lifecycle |
| `tracker/portal/taskz_client.py` (create) | taskz.id calls |
| `tracker/portal/server.py` (create) | HTTP server |
| `tracker/portal/static/index.html` (create) | Phone UI |
| `tracker/portal/tests/fake_exporter.py` (create) | Scripted fake export-findmy |
| `tracker/portal/tests/test_driver.py`, `test_session.py`, `test_server.py` (create) | Tests |
| `tracker/sync_airtags.py`, `tracker/test_sync.py` (modify) | Shared accounts + portal health |
| `tracker/com.buzzbot.tracker-portal.plist` (create), `tracker/README.md` (modify) | Ops |

---

### Task 1: Server — invites

**Files:** Create `server/src/services/trackerInvites.js`, `server/test/trackerInvites.test.js`; modify `server/src/db.js`, `server/src/routes/equipment.js`.

**Interfaces — Produces (HTTP):**
- `POST /api/equipment/tracker/invites` (admin) `{label}` → `201 {id, url}` | `400`
- `GET /api/equipment/tracker/invites` (admin) → `[{id,label,created_at,expires_at,attempts_left,status,tags_saved,note}]`
- `DELETE /api/equipment/tracker/invites/:id` (admin) → `200` | `409`
- `POST /api/equipment/tracker/invites/check` (ingest) `{token}` → `{ok:true,id,label,attempts_left}` | `{ok:false}`
- `POST /api/equipment/tracker/invites/:id/{attempt|complete|failed|cleanup-failed}` (ingest) → `200 {status}` | `409`
- inventory body may carry `portal:{ok,version}`; `tracking-status` adds `portal_url`, `portal_last_ok_at`

- [ ] **Step 1: Table** — in `server/src/db.js`, append to the tracker_items `db.exec` block (before its closing backtick):

```sql
    CREATE TABLE IF NOT EXISTS tracker_invites (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts_left INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      tags_saved INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT ''
    );
```

- [ ] **Step 2: Failing tests** — `server/test/trackerInvites.test.js`:

```js
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initDb } from '../src/db.js';
import { signToken } from '../src/middleware/auth.js';
import equipmentRoutes from '../src/routes/equipment.js';

let db, server, base, dbPath, admin, member;
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
  base = `http://127.0.0.1:${server.address().port}/api/equipment`;
});

after(() => {
  server?.close();
  db?.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.TRACKER_INGEST_KEY;
  delete process.env.TRACKER_PORTAL_URL;
});

beforeEach(() => {
  process.env.TRACKER_INGEST_KEY = KEY;
  process.env.TRACKER_PORTAL_URL = 'https://tags.example.test';
  db.exec('DELETE FROM tracker_invites');
  db.exec('DELETE FROM app_settings');
  db.exec("DELETE FROM team_members WHERE id LIKE 'm%'");
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m1','Alex',1,1)").run();
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m2','Sam',0,1)").run();
  admin = `auth_token=${signToken('m1', true)}`;
  member = `auth_token=${signToken('m2', false)}`;
});

const call = (p, { method = 'GET', body, cookie, key } = {}) => fetch(`${base}${p}`, {
  method,
  headers: {
    'Content-Type': 'application/json',
    ...(cookie ? { cookie } : {}),
    ...(key ? { 'X-Ingest-Key': key } : {}),
  },
  body: body ? JSON.stringify(body) : undefined,
});
const create = async (label = 'Sam – WA') => (await call('/tracker/invites', { method: 'POST', body: { label }, cookie: admin })).json();
const tokenOf = (url) => url.split('/i/')[1];

test('admin creates an invite; only the hash is stored', async () => {
  const res = await call('/tracker/invites', { method: 'POST', body: { label: 'Sam – WA' }, cookie: admin });
  assert.equal(res.status, 201);
  const { id, url } = await res.json();
  assert.match(url, /^https:\/\/tags\.example\.test\/i\/[A-Za-z0-9_-]{43}$/);
  const row = db.prepare('SELECT * FROM tracker_invites WHERE id = ?').get(id);
  assert.equal(row.token_hash, crypto.createHash('sha256').update(tokenOf(url)).digest('hex'));
  assert.equal(JSON.stringify(row).includes(tokenOf(url)), false);
  assert.equal(row.attempts_left, 3);
  assert.equal(row.status, 'pending');
});

test('creating needs an admin, a label and a configured portal', async () => {
  assert.equal((await call('/tracker/invites', { method: 'POST', body: { label: 'x' }, cookie: member })).status, 403);
  assert.equal((await call('/tracker/invites', { method: 'POST', body: { label: '  ' }, cookie: admin })).status, 400);
  delete process.env.TRACKER_PORTAL_URL;
  assert.equal((await call('/tracker/invites', { method: 'POST', body: { label: 'x' }, cookie: admin })).status, 400);
});

test('list never exposes tokens and computes expiry', async () => {
  const { id } = await create();
  db.prepare("UPDATE tracker_invites SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);
  const list = await (await call('/tracker/invites', { cookie: admin })).json();
  assert.equal(list[0].status, 'expired');
  assert.equal('token_hash' in list[0], false);
});

test('check needs the ingest key and a live token', async () => {
  const { url, id } = await create();
  const token = tokenOf(url);
  assert.equal((await call('/tracker/invites/check', { method: 'POST', body: { token }, key: 'nope' })).status, 401);
  let r = await (await call('/tracker/invites/check', { method: 'POST', body: { token }, key: KEY })).json();
  assert.deepEqual(r, { ok: true, id, label: 'Sam – WA', attempts_left: 3 });
  r = await (await call('/tracker/invites/check', { method: 'POST', body: { token: 'wrong' }, key: KEY })).json();
  assert.deepEqual(r, { ok: false });
});

test('attempts count down; failure returns to pending until none are left', async () => {
  const { url, id } = await create();
  for (let i = 0; i < 3; i++) {
    assert.equal((await call(`/tracker/invites/${id}/attempt`, { method: 'POST', key: KEY })).status, 200);
    const s = await (await call(`/tracker/invites/${id}/failed`, { method: 'POST', body: { note: 'bad_password' }, key: KEY })).json();
    assert.equal(s.status, i < 2 ? 'pending' : 'failed');
  }
  const r = await (await call('/tracker/invites/check', { method: 'POST', body: { token: tokenOf(url) }, key: KEY })).json();
  assert.equal(r.ok, false);
  assert.equal((await call(`/tracker/invites/${id}/attempt`, { method: 'POST', key: KEY })).status, 409);
});

test('complete makes the link single-use', async () => {
  const { url, id } = await create();
  await call(`/tracker/invites/${id}/attempt`, { method: 'POST', key: KEY });
  const s = await (await call(`/tracker/invites/${id}/complete`, { method: 'POST', body: { tags_saved: 2 }, key: KEY })).json();
  assert.equal(s.status, 'done');
  const r = await (await call('/tracker/invites/check', { method: 'POST', body: { token: tokenOf(url) }, key: KEY })).json();
  assert.equal(r.ok, false);
  assert.equal(db.prepare('SELECT tags_saved FROM tracker_invites WHERE id = ?').get(id).tags_saved, 2);
});

test('cleanup-failed is recorded for the admin', async () => {
  const { id } = await create();
  await call(`/tracker/invites/${id}/attempt`, { method: 'POST', key: KEY });
  await call(`/tracker/invites/${id}/complete`, { method: 'POST', body: { tags_saved: 1 }, key: KEY });
  const s = await (await call(`/tracker/invites/${id}/cleanup-failed`, { method: 'POST', body: { note: 'bottle not found' }, key: KEY })).json();
  assert.equal(s.status, 'cleanup_needed');
});

test('admin can cancel a pending invite only', async () => {
  const { id } = await create();
  assert.equal((await call(`/tracker/invites/${id}`, { method: 'DELETE', cookie: admin })).status, 200);
  assert.equal((await call(`/tracker/invites/${id}`, { method: 'DELETE', cookie: admin })).status, 409);
});

test('portal status from the inventory call shows in tracking-status', async () => {
  await call('/tracker/inventory', { method: 'POST', body: { items: [], portal: { ok: true, version: '1' } }, key: KEY });
  const s = await (await call('/tracking-status', { cookie: admin })).json();
  assert.equal(s.portal_url, 'https://tags.example.test');
  assert.match(s.portal_last_ok_at, /^\d{4}-/);
});
```

- [ ] **Step 3:** Run `node --test server/test/trackerInvites.test.js` — expect FAIL (404s).

- [ ] **Step 4: Service** — `server/src/services/trackerInvites.js`:

```js
// One-time invite links for the tag export portal on the tracker Mac.
// Tokens are shown once and stored only as a SHA-256 hash.
import crypto from 'crypto';

export const INVITE_TTL_MS = 24 * 3600 * 1000;
export const INVITE_ATTEMPTS = 3;
const PORTAL_KEY = 'tracker_portal_status';

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function createInvite(db, { label, createdBy }, nowMs = Date.now()) {
  const token = crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO tracker_invites (id, token_hash, label, created_by, created_at, expires_at, attempts_left)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, hashToken(token), label, createdBy || null,
    new Date(nowMs).toISOString(), new Date(nowMs + INVITE_TTL_MS).toISOString(), INVITE_ATTEMPTS);
  return { id, token };
}

export function effectiveStatus(row, nowMs = Date.now()) {
  if (row.status === 'pending' && Date.parse(row.expires_at) <= nowMs) return 'expired';
  return row.status;
}

export function listInvites(db, nowMs = Date.now()) {
  return db.prepare(`
    SELECT id, label, created_at, expires_at, attempts_left, status, tags_saved, note
    FROM tracker_invites ORDER BY created_at DESC LIMIT 50
  `).all().map((r) => ({ ...r, status: effectiveStatus(r, nowMs) }));
}

export function checkInvite(db, token, nowMs = Date.now()) {
  if (!token) return { ok: false };
  const row = db.prepare('SELECT * FROM tracker_invites WHERE token_hash = ?').get(hashToken(token));
  if (!row || effectiveStatus(row, nowMs) !== 'pending' || row.attempts_left < 1) return { ok: false };
  return { ok: true, id: row.id, label: row.label, attempts_left: row.attempts_left };
}

function get(db, id) {
  return db.prepare('SELECT * FROM tracker_invites WHERE id = ?').get(id);
}

// Each returns the new status, or null when the transition is not allowed.
export function recordAttempt(db, id, nowMs = Date.now()) {
  const row = get(db, id);
  if (!row || effectiveStatus(row, nowMs) !== 'pending' || row.attempts_left < 1) return null;
  db.prepare("UPDATE tracker_invites SET attempts_left = attempts_left - 1, status = 'in_progress' WHERE id = ?").run(id);
  return 'in_progress';
}

export function completeInvite(db, id, tagsSaved) {
  const row = get(db, id);
  if (!row || row.status !== 'in_progress') return null;
  db.prepare("UPDATE tracker_invites SET status = 'done', tags_saved = ? WHERE id = ?")
    .run(Math.max(0, parseInt(tagsSaved, 10) || 0), id);
  return 'done';
}

export function failInvite(db, id, note) {
  const row = get(db, id);
  if (!row || row.status !== 'in_progress') return null;
  const status = row.attempts_left > 0 ? 'pending' : 'failed';
  db.prepare('UPDATE tracker_invites SET status = ?, note = ? WHERE id = ?').run(status, String(note || '').slice(0, 200), id);
  return status;
}

export function markCleanupFailed(db, id, note) {
  const row = get(db, id);
  if (!row) return null;
  db.prepare("UPDATE tracker_invites SET status = 'cleanup_needed', note = ? WHERE id = ?")
    .run(String(note || '').slice(0, 200), id);
  return 'cleanup_needed';
}

export function cancelInvite(db, id, nowMs = Date.now()) {
  const row = get(db, id);
  if (!row || effectiveStatus(row, nowMs) !== 'pending') return null;
  db.prepare("UPDATE tracker_invites SET status = 'cancelled' WHERE id = ?").run(id);
  return 'cancelled';
}

export function recordPortalStatus(db, portal, nowIso) {
  if (!portal || typeof portal !== 'object') return;
  const value = JSON.stringify({ ok: !!portal.ok, version: String(portal.version || ''), at: nowIso });
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(PORTAL_KEY, value);
}

export function portalLastOkAt(db) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(PORTAL_KEY);
  try {
    const v = row ? JSON.parse(row.value) : null;
    return v && v.ok ? v.at : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Routes** — in `server/src/routes/equipment.js` add import:

```js
import {
  createInvite, listInvites, checkInvite, recordAttempt, completeInvite, failInvite,
  markCleanupFailed, cancelInvite, recordPortalStatus, portalLastOkAt,
} from '../services/trackerInvites.js';
```

In `POST /tracker/inventory`, after the `items` check, add `recordPortalStatus(req.db, req.body.portal, new Date().toISOString());` (before `res.json`). In `tracking-status` response add:

```js
    portal_url: process.env.TRACKER_PORTAL_URL || null,
    portal_last_ok_at: portalLastOkAt(req.db),
```

Add before `// ── Booking index`:

```js
// ── Export portal invites ────────────────────────────────────────────
router.post('/tracker/invites', requireAuth, requireAdmin, (req, res) => {
  const portal = process.env.TRACKER_PORTAL_URL;
  if (!portal) return res.status(400).json({ error: 'TRACKER_PORTAL_URL is not set on the server' });
  const label = String(req.body?.label || '').trim().slice(0, 60);
  if (!label) return res.status(400).json({ error: 'A label is required' });
  const { id, token } = createInvite(req.db, { label, createdBy: req.user?.memberId });
  res.status(201).json({ id, url: `${portal.replace(/\/$/, '')}/i/${token}` });
});

router.get('/tracker/invites', requireAuth, requireAdmin, (req, res) => {
  res.json(listInvites(req.db));
});

router.delete('/tracker/invites/:id', requireAuth, requireAdmin, (req, res) => {
  const status = cancelInvite(req.db, req.params.id);
  if (!status) return res.status(409).json({ error: 'Only pending invites can be cancelled' });
  res.json({ status });
});

router.post('/tracker/invites/check', (req, res) => {
  if (!ingestKeyMatches(req)) return res.status(401).json({ error: 'Valid X-Ingest-Key required' });
  res.json(checkInvite(req.db, req.body?.token));
});

const INVITE_STEPS = {
  attempt: (db, id) => recordAttempt(db, id),
  complete: (db, id, body) => completeInvite(db, id, body?.tags_saved),
  failed: (db, id, body) => failInvite(db, id, body?.note),
  'cleanup-failed': (db, id, body) => markCleanupFailed(db, id, body?.note),
};

router.post('/tracker/invites/:id/:step', (req, res) => {
  if (!ingestKeyMatches(req)) return res.status(401).json({ error: 'Valid X-Ingest-Key required' });
  const fn = INVITE_STEPS[req.params.step];
  if (!fn) return res.status(404).json({ error: 'Unknown step' });
  const status = fn(req.db, req.params.id, req.body);
  if (!status) return res.status(409).json({ error: 'Invite is not in a state for that step' });
  res.json({ status });
});
```

- [ ] **Step 6:** `node --test server/test/trackerInvites.test.js` → PASS; `npm test` → all pass.
- [ ] **Step 7:** Commit `feat(tracker): export portal invites on the server`.

---

### Task 2: V2 — Invites and portal tile

**Files:** Modify `client-v2/src/lib/tracker.js`, `client-v2/test/tracker.test.js`, `client-v2/src/api.js`, `client-v2/src/components/Settings.jsx`; create `client-v2/src/components/TrackerInvites.jsx`.

**Interfaces — Produces:** `inviteStatusText(inv) -> string`, `INVITE_TONE`, `portalOnline(status, nowMs) -> boolean`.

- [ ] **Step 1: Failing tests** — append to `client-v2/test/tracker.test.js`:

```js
import { inviteStatusText, portalOnline } from '../src/lib/tracker.js';

test('inviteStatusText', () => {
  assert.equal(inviteStatusText({ status: 'pending', attempts_left: 3 }), 'Waiting');
  assert.equal(inviteStatusText({ status: 'pending', attempts_left: 1 }), 'Waiting · 1 try left');
  assert.equal(inviteStatusText({ status: 'done', tags_saved: 2 }), 'Done · 2 tags');
  assert.equal(inviteStatusText({ status: 'cleanup_needed' }), 'Cleanup needed');
  assert.equal(inviteStatusText({ status: 'expired' }), 'Expired');
});

test('portalOnline is true within an hour of the last good report', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  assert.equal(portalOnline({ portal_last_ok_at: '2026-09-27T11:30:00Z' }, now), true);
  assert.equal(portalOnline({ portal_last_ok_at: '2026-09-27T10:30:00Z' }, now), false);
  assert.equal(portalOnline({ portal_last_ok_at: null }, now), false);
});
```

- [ ] **Step 2:** `node --test client-v2/test/tracker.test.js` → FAIL.

- [ ] **Step 3:** Append to `client-v2/src/lib/tracker.js`:

```js
export const INVITE_TONE = {
  pending: 'warn', in_progress: 'warn', done: 'ok', expired: 'mute', cancelled: 'mute', failed: 'danger', cleanup_needed: 'danger',
};

export function inviteStatusText(inv) {
  switch (inv.status) {
    case 'pending': return inv.attempts_left < 3 ? `Waiting · ${inv.attempts_left} ${inv.attempts_left === 1 ? 'try' : 'tries'} left` : 'Waiting';
    case 'in_progress': return 'In progress';
    case 'done': return `Done · ${inv.tags_saved} tag${inv.tags_saved === 1 ? '' : 's'}`;
    case 'expired': return 'Expired';
    case 'cancelled': return 'Cancelled';
    case 'failed': return 'Failed';
    case 'cleanup_needed': return 'Cleanup needed';
    default: return inv.status;
  }
}

export function portalOnline(status, nowMs = Date.now()) {
  const at = status?.portal_last_ok_at;
  return !!at && nowMs - Date.parse(at) < 3600000;
}
```

- [ ] **Step 4:** Test → PASS.

- [ ] **Step 5: API** — append under the tracker calls in `client-v2/src/api.js`:

```js
export const getInvites = () => api('/equipment/tracker/invites');
export const createInvite = (label) =>
  api('/equipment/tracker/invites', { method: 'POST', body: JSON.stringify({ label }) });
export const cancelInvite = (id) => api(`/equipment/tracker/invites/${id}`, { method: 'DELETE' });
```

- [ ] **Step 6: Component** — `client-v2/src/components/TrackerInvites.jsx`:

```jsx
import React, { useEffect, useState } from 'react';
import { Section } from './ui.jsx';
import { getInvites, createInvite, cancelInvite } from '../api.js';
import { inviteStatusText, INVITE_TONE } from '../lib/tracker.js';

// One-time links that let someone add their tags from their phone through
// the portal on the tracker Mac. A link is shown once, works once, and
// expires after 24 hours.
export default function TrackerInvites({ showToast }) {
  const [invites, setInvites] = useState(null);
  const [label, setLabel] = useState('');
  const [link, setLink] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => getInvites().then(setInvites).catch((e) => showToast?.(e.message, 'error'));
  useEffect(() => { load(); }, []);

  const create = async () => {
    setBusy(true);
    try {
      const r = await createInvite(label.trim());
      setLink({ label: label.trim(), url: r.url });
      setLabel('');
      await load();
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      showToast?.('Link copied — send it to them by text', 'success');
    } catch {
      showToast?.('Copy failed — select the link and copy it', 'error');
    }
  };

  return (
    <Section title="Add tags from a phone">
      <p className="settings-lead" style={{ margin: '0 0 10px' }}>
        Send someone a one-time link. They sign in to their Apple ID on their phone,
        pick which tags to share, and the tags appear above as “Not included”.
      </p>
      <div className="inv-new">
        <input
          value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60}
          placeholder="Who is it for? e.g. Sam – WA" aria-label="Invite label"
        />
        <button className="btn btn-primary" disabled={busy || !label.trim()} onClick={create}>Create link</button>
      </div>
      {link && (
        <div className="banner banner-warn inv-link">
          <div>Link for <strong>{link.label}</strong> — shown once, works once, expires in 24 hours:</div>
          <code className="inv-url">{link.url}</code>
          <button className="btn" onClick={copy}>Copy</button>
        </div>
      )}
      {invites && invites.length > 0 && (
        <div className="inv-list">
          {invites.map((inv) => (
            <div className="entry-row" key={inv.id}>
              <span className="entry-name">{inv.label}</span>
              <span className={`tag tag-${INVITE_TONE[inv.status] || 'mute'}`}>{inviteStatusText(inv)}</span>
              {inv.note && <span className="rl-sub">{inv.note}</span>}
              {inv.status === 'pending' && (
                <button className="btn" disabled={busy}
                  onClick={() => cancelInvite(inv.id).then(load).catch((e) => showToast?.(e.message, 'error'))}>
                  Cancel
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
```

Append to `client-v2/src/styles.css`:

```css
.inv-new { display: flex; gap: 8px; margin-bottom: 10px; }
.inv-new input { flex: 1; min-width: 0; }
.inv-link { display: grid; gap: 6px; }
.inv-url { word-break: break-all; user-select: all; }
.inv-list .entry-row { gap: 8px; }
```

- [ ] **Step 7: Settings** — in `Settings.jsx`: import `TrackerInvites` and `{ portalOnline }` from `../lib/tracker.js`. Add after the "Tracker Mac last reported" `Stat`:

```jsx
              {status.portal_url && (
                <Stat
                  label="Export portal"
                  value={portalOnline(status) ? 'Online' : 'Offline'}
                  tone={portalOnline(status) ? 'ok' : 'danger'}
                />
              )}
```

Render `{status?.portal_url && <TrackerInvites showToast={showToast} />}` directly after `<TrackerTags … />`, and wrap the whole `<details className="admin-setup">…</details>` in `{!status?.portal_url && ( … )}`.

- [ ] **Step 8:** `npm test && (cd client-v2 && npx vite build)` → pass. Commit `feat(v2): export portal invites in Settings → Tracking`.

---

### Task 3: Mac — exporter driver (with fake exporter)

**Files:** Create `tracker/portal/__init__.py` (empty), `tracker/portal/tests/__init__.py` (empty), `tracker/portal/tests/fake_exporter.py`, `tracker/portal/exporter_driver.py`, `tracker/portal/tests/test_driver.py`. Install `pexpect` in the venv.

**Interfaces — Produces:**
- `Step` dataclass: `kind: str`, `options: list[dict] | None`, `device: str | None`, `error: str | None`, `detail: str | None`
- kinds: `need_password`, `need_2fa_method` (options `[{"index": int, "label": str}]`), `need_code`, `need_bottle` (options), `need_passcode` (device), `finished`, `no_items`, `error` (error ∈ `bad_password`, `bad_code`, `hardware_key`, `apple_unavailable`, `no_bottles`, `unknown`)
- `ExporterDriver(argv: list[str], env: dict, silence_timeout: float = 90)` with `start() -> Step`, `answer(value: str) -> Step`, `close() -> None`, `passcode_sent: bool`
- `delete_bottle(argv: list[str], env: dict, serial: str, timeout: float = 90) -> tuple[bool, str]`

- [ ] **Step 1:** `cd tracker && .venv/bin/pip install 'pexpect>=4.9'`

- [ ] **Step 2: Fake exporter** — `tracker/portal/tests/fake_exporter.py`:

```python
#!/usr/bin/env python3
"""Stand-in for export-findmy with the same prompts (see plan's prompt table).

FAKE_SCENARIO: ok | two_bottles | sms | bad_password | hardware_key |
no_items | hang | unavailable | no_bottles
FAKE_ITEMS (ok): JSON list of {"name","model","identifier","emoji"}.
Delete mode (--delete-own-escrow-bottle): FAKE_BOTTLE_SERIALS comma list;
succeeds when the chosen serial is typed back.
"""
import getpass
import json
import os
import sys
import time


def err(s="", end="\n"):
    sys.stderr.write(s + end)
    sys.stderr.flush()


def arg(name):
    a = sys.argv
    return a[a.index(name) + 1] if name in a else None


def delete_mode():
    serials = [s for s in os.environ.get("FAKE_BOTTLE_SERIALS", "").split(",") if s]
    err("[1/3] Connecting to anisette server...")
    err("[2/3] Authenticating Apple ID...")
    err("  Loaded cached authentication")
    err("[3/3] Setting up escrow maintenance...")
    err(f"Found {len(serials)} escrow bottle(s):")
    for i, s in enumerate(serials):
        err(f"  [{i}] Device {i} (iPhone)")
        err(f"      serial: {s}, build: 21E219, escrowed: 2026-09-27")
    err()
    err("WARNING: This list may include bottles belonging to real Apple devices.")
    sel = input_prompt("Choose a bottle to delete, or press Enter to cancel: ")
    if not sel:
        err("Deletion cancelled.")
        return 0
    i = int(sel)
    err(f"Selected: Device {i} (iPhone) (serial {serials[i]})")
    getpass_prompt("Escrow password [press Enter to use the saved profile password]: ")
    err("Escrow bottle unlocked successfully.")
    if input_prompt(f"Type DELETE {i} to permanently delete this escrow bottle: ") != f"DELETE {i}":
        err("Deletion cancelled.")
        return 0
    if input_prompt(f"Final confirmation: type the device serial {serials[i]}: ") != serials[i]:
        err("Deletion cancelled.")
        return 0
    err(f"Deleted escrow bottle: Device {i} (iPhone)")
    return 0


def input_prompt(p):
    err(p, end="")
    return sys.stdin.readline().strip()


def getpass_prompt(p):
    return getpass.getpass(p, stream=sys.stderr)


def main():
    if "--delete-own-escrow-bottle" in sys.argv:
        return delete_mode()
    sc = os.environ.get("FAKE_SCENARIO", "ok")
    out = arg("--output-dir")
    err("Using device profile: x")
    err("[1/7] Connecting to anisette server...")
    if sc == "unavailable":
        err("Error: Error response for GSA request: 503")
        return 1
    err("[2/7] Authenticating Apple ID...")
    if sc == "hang":
        time.sleep(3600)
    pw = getpass_prompt("Password: ")
    if sc == "bad_password" or pw == "wrong":
        err("Error: AuthSrpWithMessage(-20101, \"Your Apple ID or password was incorrect.\")")
        return 1
    if sc == "hardware_key":
        err("Error: security key required for this Apple ID")
        return 1
    err("  0 - Trusted Device")
    if sc == "sms":
        err("  1 - SMS (•••• •••• 12)")
    input_prompt("Method [0]: ")
    code = input_prompt("Code: ")
    if code == "000000":
        err("Error: AuthSrpWithMessage(-21669, \"Incorrect verification code.\")")
        return 1
    err("  Logged in (dsid=1)")
    err("[3/7] Fetching MobileMe delegate...")
    err("[4/7] Setting up CloudKit & Keychain...")
    err("[5/7] Joining iCloud Keychain trust circle...")
    if sc == "no_bottles":
        err("No usable escrow bottles found.")
        err("Error: No usable escrow bottles found. Confirm iCloud Keychain is enabled on a trusted Apple device and that device has a passcode.")
        return 1
    bottles = ["Sam's iPhone (iPhone) (serial AAA)"] + (["Sam's iPad (iPad) (serial BBB)"] if sc == "two_bottles" else [])
    err(f"  Found {len(bottles)} escrow bottle(s):")
    for i, b in enumerate(bottles):
        err(f"    [{i}] {b.split(' (serial')[0]}")
        err("        serial: X, build: 21E219, escrowed: 2026-09-27")
    idx = 0
    if len(bottles) > 1:
        idx = int(input_prompt("  Choose bottle [0]: ") or 0)
    err(f"  Using escrow bottle from device: {bottles[idx]}")
    getpass_prompt("  Enter the passcode of that device: ")
    err("  Joined keychain trust circle!")
    err("[6/7] Fetching FindMy accessories from CloudKit...")
    err("[7/7] Writing plist and json files...")
    items = json.loads(os.environ.get("FAKE_ITEMS", "[]"))
    if sc == "no_items" or not items:
        err("  No accessories found!")
        return 0
    os.makedirs(out, exist_ok=True)
    for it in items:
        base = it["identifier"].replace("/", "_").replace(":", "_").replace("~", "_").replace("#", "_")
        with open(os.path.join(out, base + ".json"), "w") as f:
            json.dump({"type": "accessory", "name": it["name"], "model": it.get("model", ""),
                       "identifier": it["identifier"], "emoji": it.get("emoji", ""),
                       "serial_number": "", "master_key": "00", "skn": "00", "sks": "00",
                       "paired_at": "2026-01-01T00:00:00+00:00"}, f)
        open(os.path.join(out, base + ".plist"), "w").write("<plist/>")
    err()
    err(f"Done! Exported {len(items)} accessory file pair(s) (plist + json) to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 3: Failing tests** — `tracker/portal/tests/test_driver.py`:

```python
import json
import os
import sys
import tempfile
import unittest

from portal.exporter_driver import ExporterDriver, delete_bottle

FAKE = [sys.executable, os.path.join(os.path.dirname(__file__), "fake_exporter.py")]
ITEMS = json.dumps([
    {"name": "Drone case", "identifier": "2006~#aa~#SER1", "emoji": "🧳"},
    {"name": "Sam's iPhone", "model": "iPhone13,4", "identifier": "me:/x"},
])


def driver(scenario, tmp, silence=10, items=ITEMS):
    env = dict(os.environ, FAKE_SCENARIO=scenario, FAKE_ITEMS=items)
    return ExporterDriver(FAKE + ["--output-dir", tmp], env, silence_timeout=silence)


class Driver(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def test_happy_path(self):
        d = driver("ok", self.tmp)
        self.assertEqual(d.start().kind, "need_password")
        s = d.answer("pw")
        self.assertEqual(s.kind, "need_2fa_method")
        self.assertEqual(s.options, [{"index": 0, "label": "Trusted Device"}])
        self.assertEqual(d.answer("0").kind, "need_code")
        s = d.answer("123456")
        self.assertEqual(s.kind, "need_passcode")
        self.assertEqual(s.device, "Sam's iPhone (iPhone)")
        self.assertFalse(d.passcode_sent)
        self.assertEqual(d.answer("1234").kind, "finished")
        self.assertTrue(d.passcode_sent)
        self.assertEqual(len([f for f in os.listdir(self.tmp) if f.endswith(".json")]), 2)

    def test_sms_and_two_bottles(self):
        d = driver("sms", self.tmp)
        d.start()
        s = d.answer("pw")
        self.assertEqual([o["label"] for o in s.options], ["Trusted Device", "SMS (•••• •••• 12)"])
        d = driver("two_bottles", self.tmp)
        d.start(); d.answer("pw"); d.answer("0")
        s = d.answer("123456")
        self.assertEqual(s.kind, "need_bottle")
        self.assertEqual(len(s.options), 2)
        self.assertEqual(d.answer("1").device, "Sam's iPad (iPad)")

    def test_errors_are_classified(self):
        cases = {"bad_password": "bad_password", "hardware_key": "hardware_key",
                 "unavailable": "apple_unavailable", "no_bottles": "no_bottles"}
        for sc, want in cases.items():
            d = driver(sc, self.tmp)
            s = d.start()
            if s.kind == "need_password":
                s = d.answer("pw")
            if s.kind == "need_2fa_method":
                s = d.answer("0"); s = d.answer("123456")
            self.assertEqual((s.kind, s.error), ("error", want), sc)

    def test_wrong_code(self):
        d = driver("ok", self.tmp)
        d.start(); d.answer("pw"); d.answer("0")
        s = d.answer("000000")
        self.assertEqual((s.kind, s.error), ("error", "bad_code"))

    def test_no_items(self):
        d = driver("no_items", self.tmp)
        d.start(); d.answer("pw"); d.answer("0"); d.answer("123456")
        self.assertEqual(d.answer("1234").kind, "no_items")

    def test_silence_is_apple_unavailable(self):
        d = driver("hang", self.tmp, silence=1)
        s = d.start()
        self.assertEqual((s.kind, s.error), ("error", "apple_unavailable"))
        d.close()

    def test_delete_bottle_by_serial(self):
        env = dict(os.environ, FAKE_BOTTLE_SERIALS="REAL1,TZSESSION1")
        ok, _ = delete_bottle(FAKE, env, "TZSESSION1")
        self.assertTrue(ok)
        ok, why = delete_bottle(FAKE, env, "NOTTHERE")
        self.assertFalse(ok)
        self.assertIn("not found", why)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 4:** `cd tracker && .venv/bin/python -m unittest portal.tests.test_driver` → FAIL (module missing).

- [ ] **Step 5: Driver** — `tracker/portal/exporter_driver.py`:

```python
"""Drive export-findmy's interactive prompts through a pty.

Answers (password, codes, passcode) are written straight to the child and
never logged: pexpect's logfile stays None and nothing here prints them.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import pexpect

PROMPTS = [
    ("need_password", r"(?m)^Password: "),
    ("need_2fa_method", r"Method \[0\]: "),
    ("need_code", r"(?m)^Code: "),
    ("need_bottle", r"Choose bottle \[0\]: "),
    ("need_passcode", r"Enter the passcode of that device: "),
]
METHOD_RE = re.compile(r"^\s+(\d+) - (.+?)\s*$", re.M)
BOTTLE_RE = re.compile(r"^\s{4}\[(\d+)\] (.+?)\s*$", re.M)
USING_RE = re.compile(r"Using escrow bottle from device: (.+?) \(serial ")

ERROR_PATTERNS = [
    ("bad_code", re.compile(r"-21669|verification code", re.I)),
    ("bad_password", re.compile(r"-20101|password was incorrect|incorrect password", re.I)),
    ("hardware_key", re.compile(r"security key", re.I)),
    ("no_bottles", re.compile(r"No usable escrow bottles", re.I)),
    ("apple_unavailable", re.compile(r"\b503\b|anisette|timed out|connection", re.I)),
]


@dataclass
class Step:
    kind: str
    options: list | None = None
    device: str | None = None
    error: str | None = None
    detail: str | None = None


def classify_error(text: str) -> str:
    for kind, rx in ERROR_PATTERNS:
        if rx.search(text):
            return kind
    return "unknown"


def last_line(text: str) -> str:
    lines = [ln.strip() for ln in text.strip().splitlines() if ln.strip()]
    return lines[-1][:200] if lines else ""


class ExporterDriver:
    def __init__(self, argv: list[str], env: dict, silence_timeout: float = 90):
        self.argv = argv
        self.env = env
        self.silence_timeout = silence_timeout
        self.child = None
        self.buf = ""
        self.passcode_sent = False
        self._awaiting = None

    def start(self) -> Step:
        self.child = pexpect.spawn(self.argv[0], self.argv[1:], env=self.env,
                                   encoding="utf-8", timeout=self.silence_timeout,
                                   echo=False, logfile=None)
        return self._next()

    def answer(self, value: str) -> Step:
        if self._awaiting == "need_passcode":
            self.passcode_sent = True
        self.child.sendline(value)
        return self._next()

    def close(self) -> None:
        if self.child is not None and self.child.isalive():
            self.child.terminate(force=True)

    def _next(self) -> Step:
        patterns = [p for _, p in PROMPTS] + [pexpect.EOF, pexpect.TIMEOUT]
        i = self.child.expect(patterns)
        text = self.child.before or ""
        self.buf += text
        if i < len(PROMPTS):
            kind = PROMPTS[i][0]
            self._awaiting = kind
            if kind == "need_2fa_method":
                opts = [{"index": int(n), "label": lab} for n, lab in METHOD_RE.findall(text)]
                return Step(kind, options=opts)
            if kind == "need_bottle":
                opts = [{"index": int(n), "label": lab} for n, lab in BOTTLE_RE.findall(text)]
                return Step(kind, options=opts)
            if kind == "need_passcode":
                m = USING_RE.search(text)
                return Step(kind, device=m.group(1) if m else "your iPhone")
            return Step(kind)
        if i == len(PROMPTS) + 1:  # TIMEOUT: no output for silence_timeout
            self.close()
            return Step("error", error="apple_unavailable", detail="no response")
        self.child.close()
        code = self.child.exitstatus
        if code == 0 and "No accessories found" in self.buf:
            return Step("no_items")
        if code == 0 and "Done! Exported" in self.buf:
            return Step("finished")
        return Step("error", error=classify_error(self.buf), detail=last_line(self.buf))


def delete_bottle(argv: list[str], env: dict, serial: str, timeout: float = 90) -> tuple[bool, str]:
    """Delete the escrow bottle whose serial matches this session's profile."""
    child = pexpect.spawn(argv[0], argv[1:] + ["--delete-own-escrow-bottle"], env=env,
                          encoding="utf-8", timeout=timeout, echo=False, logfile=None)
    try:
        i = child.expect([r"Choose a bottle to delete, or press Enter to cancel: ",
                          r"(?m)^Password: ", pexpect.EOF, pexpect.TIMEOUT])
        if i != 0:
            return False, "could not sign in again to delete the bottle"
        listing = child.before or ""
        index = None
        for n, s in re.findall(r"\[(\d+)\][^\n]*\n\s+serial: ([^,\s]+),", listing):
            if s == serial:
                index = n
        if index is None:
            child.sendline("")
            return False, f"bottle with serial {serial} not found"
        child.sendline(index)
        child.expect(r"Escrow password \[press Enter to use the saved profile password\]: ")
        child.sendline("")
        child.expect(rf"Type DELETE {index} to permanently delete this escrow bottle: ")
        child.sendline(f"DELETE {index}")
        child.expect(r"Final confirmation: type the device serial \S+: ")
        child.sendline(serial)
        j = child.expect([r"Deleted escrow bottle", pexpect.EOF, pexpect.TIMEOUT])
        return (j == 0), ("deleted" if j == 0 else last_line(child.before or ""))
    except (pexpect.EOF, pexpect.TIMEOUT):
        return False, last_line(child.before or "") or "exporter stopped"
    finally:
        if child.isalive():
            child.terminate(force=True)
```

- [ ] **Step 6:** Run the driver tests → PASS. Commit `feat(tracker): portal exporter driver with fake exporter`.

---

### Task 4: Mac — export session

**Files:** Create `tracker/portal/session.py`, `tracker/portal/tests/test_session.py`.

**Interfaces — Consumes:** Task 3. **Produces:**
- `slugify(label: str, invite_id: str) -> str`
- `ExportSession(invite: dict, email: str, cfg: SessionConfig, client)`; `SessionConfig(exporter_argv: list[str], template_profile: Path, shared_root: Path, work_root: Path, idle_timeout: float = 600, silence_timeout: float = 90)`
- methods `start() -> dict`, `answer(value: str) -> dict`, `save(files: list[str]) -> dict`, `cancel() -> dict`, `reap(now: float) -> bool`, property `state: dict`, `finished: bool`
- `client` duck type: `attempt(id)`, `complete(id, n)`, `failed(id, note)`, `cleanup_failed(id, note)`, `inventory(rows)`
- state dict: `{"step": str, ...}` where step ∈ `need_password, need_2fa_method, need_code, need_bottle, need_passcode, choose, done, error` with `options`, `device`, `items` (`[{"file","name","emoji","kind","checked"}]`), `error`, `message`, `remove_device`

- [ ] **Step 1: Failing tests** — `tracker/portal/tests/test_session.py`:

```python
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from portal.session import ExportSession, SessionConfig, slugify

HERE = Path(__file__).parent
FAKE = [sys.executable, str(HERE / "fake_exporter.py")]
ITEMS = [
    {"name": "Drone case", "identifier": "2006~#aa~#SER1", "emoji": "🧳"},
    {"name": "Sam's iPhone", "model": "iPhone13,4", "identifier": "me:/x"},
]


class FakeClient:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def rec(*a):
            self.calls.append((name, a))
            return {"status": "ok"}
        return rec


class Session(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        tpl = self.root / "device-profile.template.toml"
        tpl.write_text('[device]\nname = "FindMy Export"\nserial = "F2LZN0FAKE00"\n')
        os.environ["FAKE_ITEMS"] = json.dumps(ITEMS)
        os.environ["FAKE_SCENARIO"] = "ok"
        self.client = FakeClient()
        self.cfg = SessionConfig(exporter_argv=FAKE, template_profile=tpl,
                                 shared_root=self.root / "shared", work_root=self.root / "work",
                                 silence_timeout=10)
        self.s = ExportSession({"id": "inv123456", "label": "Sam – WA"}, "sam@example.com", self.cfg, self.client)

    def run_to_choose(self):
        self.assertEqual(self.s.start()["step"], "need_password")
        self.s.answer("pw"); self.s.answer("0"); self.s.answer("123456")
        return self.s.answer("1234")

    def test_slug(self):
        self.assertEqual(slugify("Sam – WA!", "inv123456"), "sam-wa-inv123")

    def test_profile_has_unique_serial_and_clear_name(self):
        self.s.start()
        text = (self.s.tmp / "profile.toml").read_text()
        self.assertIn('name = "Taskz Tag Export"', text)
        self.assertNotIn("F2LZN0FAKE00", text)
        self.assertIn(f'serial = "{self.s.serial}"', text)
        self.assertEqual(oct(self.s.tmp.stat().st_mode & 0o777), "0o700")

    def test_choose_defaults_tags_on_devices_off(self):
        st = self.run_to_choose()
        self.assertEqual(st["step"], "choose")
        by = {i["name"]: i for i in st["items"]}
        self.assertTrue(by["Drone case"]["checked"])
        self.assertEqual(by["Sam's iPhone"]["kind"], "device")
        self.assertFalse(by["Sam's iPhone"]["checked"])

    def test_save_keeps_only_ticked_and_reports_them(self):
        st = self.run_to_choose()
        keep = [i["file"] for i in st["items"] if i["name"] == "Drone case"]
        st = self.s.save(keep)
        self.assertEqual(st["step"], "done")
        self.assertEqual(st["remove_device"], "Taskz Tag Export")
        keys = self.root / "shared" / "sam-wa-inv123" / "keys"
        self.assertEqual(sorted(p.suffix for p in keys.iterdir()), [".json", ".plist"])
        self.assertEqual(oct(keys.stat().st_mode & 0o777), "0o700")
        inv = [c for c in self.client.calls if c[0] == "inventory"][0][1][0]
        self.assertEqual([r["name"] for r in inv], ["Drone case"])
        self.assertEqual(inv[0]["account"], "shared/sam-wa-inv123")
        self.assertIn(("complete", ("inv123456", 1)), self.client.calls)
        self.assertFalse(self.s.tmp.exists(), "temp dir removed")

    def test_cleanup_deletes_bottle_after_passcode(self):
        self.run_to_choose()
        os.environ["FAKE_BOTTLE_SERIALS"] = f"REAL1,{self.s.serial}"
        self.s.save([])
        self.assertFalse(any(c[0] == "cleanup_failed" for c in self.client.calls))

    def test_cleanup_failure_is_reported(self):
        self.run_to_choose()
        os.environ["FAKE_BOTTLE_SERIALS"] = "REAL1"
        self.s.save([])
        self.assertTrue(any(c[0] == "cleanup_failed" for c in self.client.calls))

    def test_one_password_retry_then_failure(self):
        os.environ["FAKE_SCENARIO"] = "bad_password"
        self.s.start()
        st = self.s.answer("pw")
        self.assertEqual((st["step"], st.get("message")), ("need_password", "Apple didn't accept that password."))
        st = self.s.answer("pw")
        self.assertEqual((st["step"], st["error"]), ("error", "bad_password"))
        self.assertIn(("failed", ("inv123456", "bad_password")), self.client.calls)
        self.assertFalse(self.s.tmp.exists())

    def test_idle_reap_cleans_up(self):
        self.s.start()
        self.assertTrue(self.s.reap(now=self.s.last_touch + 601))
        self.assertEqual(self.s.state["error"], "timeout")
        self.assertFalse(self.s.tmp.exists())

    def test_attempt_recorded_on_start(self):
        self.s.start()
        self.assertEqual(self.client.calls[0], ("attempt", ("inv123456",)))

    def tearDown(self):
        for k in ("FAKE_BOTTLE_SERIALS",):
            os.environ.pop(k, None)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2:** `.venv/bin/python -m unittest portal.tests.test_session` → FAIL.

- [ ] **Step 3: Session** — `tracker/portal/session.py`:

```python
"""One portal export: temp workspace, exporter, choice, keep, cleanup."""
from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import string
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from portal.exporter_driver import ExporterDriver, delete_bottle

DEVICE_NAME = "Taskz Tag Export"
DEVICE_MODELS = ("iPhone", "iPad", "Mac", "Watch", "AirPods")
TERMINAL = {"done", "error"}


def classify(model: str, identifier: str) -> str:
    if (model or "").startswith(DEVICE_MODELS) or (identifier or "").startswith(("l:/", "me:/")):
        return "device"
    return "tag"


def slugify(label: str, invite_id: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or "invite"
    return f"{base}-{invite_id[:6]}"


@dataclass
class SessionConfig:
    exporter_argv: list
    template_profile: Path
    shared_root: Path
    work_root: Path
    idle_timeout: float = 600
    silence_timeout: float = 90


class ExportSession:
    def __init__(self, invite: dict, email: str, cfg: SessionConfig, client):
        self.invite = invite
        self.email = email
        self.cfg = cfg
        self.client = client
        self.serial = "TZ" + "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(10))
        self.escrow_password = secrets.token_urlsafe(24)
        self.tmp: Path | None = None
        self.driver: ExporterDriver | None = None
        self.state: dict = {"step": "starting"}
        self.last_touch = time.monotonic()
        self._retried_password = False
        self._joined = False
        self._cleaned = False
        self._lock = threading.RLock()

    # ── lifecycle ──
    @property
    def finished(self) -> bool:
        return self.state.get("step") in TERMINAL

    def _argv(self) -> list:
        return self.cfg.exporter_argv + [
            "--apple-id", self.email,
            "--device-profile", str(self.tmp / "profile.toml"),
            "--output-dir", str(self.tmp / "keys"),
            "--auth-cache", str(self.tmp / "auth.plist"),
            "--keychain-state", str(self.tmp / "keychain.plist"),
        ]

    def _env(self) -> dict:
        return dict(os.environ, EXPORT_FINDMY_ESCROW_PASSWORD=self.escrow_password)

    def _write_profile(self) -> None:
        text = self.cfg.template_profile.read_text()
        text = re.sub(r'(?m)^name = ".*"$', f'name = "{DEVICE_NAME}"', text, count=1)
        text = re.sub(r'(?m)^serial = ".*"$', f'serial = "{self.serial}"', text, count=1)
        p = self.tmp / "profile.toml"
        p.write_text(text)
        p.chmod(0o600)

    def start(self) -> dict:
        with self._lock:
            self.cfg.work_root.mkdir(parents=True, exist_ok=True)
            self.tmp = Path(tempfile.mkdtemp(prefix="export-", dir=self.cfg.work_root))
            self.tmp.chmod(0o700)
            self._write_profile()
            self.client.attempt(self.invite["id"])
            self._spawn()
            return self.state

    def _spawn(self) -> None:
        self.driver = ExporterDriver(self._argv(), self._env(), silence_timeout=self.cfg.silence_timeout)
        self._apply(self.driver.start())

    def answer(self, value: str) -> dict:
        with self._lock:
            self.last_touch = time.monotonic()
            if self.finished or self.driver is None:
                return self.state
            step = self.driver.answer(value)
            self._joined = self._joined or self.driver.passcode_sent
            if step.kind == "error" and step.error == "bad_password" and not self._retried_password:
                self._retried_password = True
                self._spawn()
                self.state["message"] = "Apple didn't accept that password."
                return self.state
            self._apply(step)
            return self.state

    def _apply(self, step) -> None:
        if step.kind == "finished":
            self.state = {"step": "choose", "items": self._items()}
        elif step.kind == "no_items":
            self._fail("no_items")
        elif step.kind == "error":
            self._fail(step.error, step.detail)
        else:
            self.state = {"step": step.kind, "options": step.options, "device": step.device}

    def _items(self) -> list:
        out = []
        for p in sorted((self.tmp / "keys").glob("*.json")):
            meta = json.loads(p.read_text())
            kind = classify(meta.get("model") or "", meta.get("identifier") or "")
            out.append({"file": p.stem, "name": meta.get("name") or p.stem, "emoji": meta.get("emoji") or "",
                        "kind": kind, "checked": kind == "tag"})
        return out

    def save(self, files: list) -> dict:
        with self._lock:
            if self.state.get("step") != "choose":
                return self.state
            slug = slugify(self.invite["label"], self.invite["id"])
            keep = {i["file"] for i in self.state["items"]} & set(files)
            rows = []
            if keep:
                dest = self.cfg.shared_root / slug / "keys"
                dest.mkdir(parents=True, exist_ok=True)
                for d in (self.cfg.shared_root, self.cfg.shared_root / slug, dest):
                    d.chmod(0o700)
                for stem in sorted(keep):
                    meta = json.loads((self.tmp / "keys" / f"{stem}.json").read_text())
                    for ext in (".json", ".plist"):
                        src = self.tmp / "keys" / f"{stem}{ext}"
                        if src.exists():
                            target = dest / src.name
                            shutil.move(str(src), target)
                            target.chmod(0o600)
                    rows.append({
                        "identifier": meta.get("identifier"), "account": f"shared/{slug}",
                        "name": meta.get("name") or "", "emoji": meta.get("emoji") or "",
                        "model": meta.get("model") or "", "serial_number": meta.get("serial_number") or "",
                        "kind": classify(meta.get("model") or "", meta.get("identifier") or ""),
                    })
                self.client.inventory(rows)
            self.client.complete(self.invite["id"], len(rows))
            self.state = {"step": "done", "saved": len(rows), "remove_device": DEVICE_NAME}
            self._cleanup()
            return self.state

    def cancel(self) -> dict:
        with self._lock:
            if not self.finished:
                self._fail("cancelled")
            return self.state

    def reap(self, now: float | None = None) -> bool:
        with self._lock:
            now = time.monotonic() if now is None else now
            if not self.finished and now - self.last_touch > self.cfg.idle_timeout:
                self._fail("timeout")
                return True
            return False

    def _fail(self, error: str, detail: str | None = None) -> None:
        self.state = {"step": "error", "error": error, "remove_device": DEVICE_NAME if self._joined else None}
        self.client.failed(self.invite["id"], error)
        self._cleanup()

    def _cleanup(self) -> None:
        if self._cleaned:
            return
        self._cleaned = True
        if self.driver is not None:
            self.driver.close()
        try:
            if self._joined and self.tmp is not None:
                ok, why = delete_bottle(self._argv(), self._env(), self.serial,
                                        timeout=self.cfg.silence_timeout)
                if not ok:
                    self.client.cleanup_failed(self.invite["id"], why)
        finally:
            if self.tmp is not None:
                shutil.rmtree(self.tmp, ignore_errors=True)
```

- [ ] **Step 4:** Tests → PASS. Commit `feat(tracker): portal export session with guaranteed cleanup`.

---

### Task 5: Mac — taskz client, HTTP server, phone page

**Files:** Create `tracker/portal/taskz_client.py`, `tracker/portal/server.py`, `tracker/portal/static/index.html`, `tracker/portal/tests/test_server.py`.

**Interfaces — Consumes:** Task 4 (`ExportSession`, `SessionConfig`). **Produces:** `TaskzClient(api_url, key)`; `make_server(cfg, client, host="127.0.0.1", port=8765) -> ThreadingHTTPServer`; `python -m portal.server` entry; HTTP: `GET /i/<token>`, `GET /`, `GET /healthz`, `GET /api/state`, `POST /api/start {email}`, `POST /api/answer {value}`, `POST /api/save {files}`, `POST /api/cancel`.

- [ ] **Step 1: Client** — `tracker/portal/taskz_client.py`:

```python
"""taskz.id calls for the portal (X-Ingest-Key auth)."""
from __future__ import annotations

import json
import urllib.request


class TaskzClient:
    def __init__(self, api_url: str, key: str, timeout: float = 20):
        self.api = api_url.rstrip("/") + "/api/equipment"
        self.key = key
        self.timeout = timeout

    def _post(self, path: str, body: dict | None = None) -> dict:
        req = urllib.request.Request(
            self.api + path, data=json.dumps(body or {}).encode(), method="POST",
            headers={"Content-Type": "application/json", "X-Ingest-Key": self.key},
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read())

    def check(self, token: str) -> dict:
        return self._post("/tracker/invites/check", {"token": token})

    def attempt(self, invite_id: str) -> dict:
        return self._post(f"/tracker/invites/{invite_id}/attempt")

    def complete(self, invite_id: str, tags_saved: int) -> dict:
        return self._post(f"/tracker/invites/{invite_id}/complete", {"tags_saved": tags_saved})

    def failed(self, invite_id: str, note: str) -> dict:
        return self._post(f"/tracker/invites/{invite_id}/failed", {"note": note})

    def cleanup_failed(self, invite_id: str, note: str) -> dict:
        return self._post(f"/tracker/invites/{invite_id}/cleanup-failed", {"note": note})

    def inventory(self, rows: list) -> dict:
        return self._post("/tracker/inventory", {"items": rows})
```

- [ ] **Step 2: Failing tests** — `tracker/portal/tests/test_server.py`:

```python
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

from portal.server import make_server
from portal.session import SessionConfig

HERE = Path(__file__).parent


class FakeTaskz:
    def __init__(self):
        self.calls = []

    def check(self, token):
        return {"ok": True, "id": "inv123456", "label": "Sam", "attempts_left": 3} if token == "good" else {"ok": False}

    def __getattr__(self, name):
        def rec(*a):
            self.calls.append((name, a))
            return {"status": "ok"}
        return rec


class Server(unittest.TestCase):
    def setUp(self):
        root = Path(tempfile.mkdtemp())
        tpl = root / "t.toml"
        tpl.write_text('[device]\nname = "x"\nserial = "y"\n')
        os.environ["FAKE_SCENARIO"] = "ok"
        os.environ["FAKE_ITEMS"] = json.dumps([{"name": "Case", "identifier": "2006~#a~#S"}])
        cfg = SessionConfig([sys.executable, str(HERE / "fake_exporter.py")], tpl, root / "shared", root / "work",
                            silence_timeout=10)
        self.taskz = FakeTaskz()
        self.httpd = make_server(cfg, self.taskz, port=0, secure_cookie=False)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    def tearDown(self):
        self.httpd.shutdown()

    def get(self, path):
        return self.opener.open(self.base + path)

    def post(self, path, body=None):
        req = urllib.request.Request(self.base + path, data=json.dumps(body or {}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        return json.loads(self.opener.open(req).read())

    def state(self):
        return json.loads(self.get("/api/state").read())

    def test_bad_link_shows_expired(self):
        self.get("/i/bad")
        self.assertEqual(self.state()["step"], "expired")

    def test_full_flow_over_http(self):
        r = self.get("/i/good")
        self.assertIn("no-store", r.headers["Cache-Control"])
        self.assertEqual(self.state()["step"], "intro")
        self.assertEqual(self.post("/api/start", {"email": "sam@example.com"})["step"], "need_password")
        self.post("/api/answer", {"value": "pw"})
        self.post("/api/answer", {"value": "0"})
        self.post("/api/answer", {"value": "123456"})
        st = self.post("/api/answer", {"value": "1234"})
        self.assertEqual(st["step"], "choose")
        st = self.post("/api/save", {"files": [st["items"][0]["file"]]})
        self.assertEqual(st["step"], "done")

    def test_second_visitor_is_told_busy(self):
        self.get("/i/good")
        self.post("/api/start", {"email": "a@example.com"})
        other = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
        other.open(self.base + "/i/good")
        req = urllib.request.Request(self.base + "/api/start", data=b'{"email":"b@example.com"}',
                                     headers={"Content-Type": "application/json"}, method="POST")
        self.assertEqual(json.loads(other.open(req).read())["step"], "busy")

    def test_no_cookie_no_session(self):
        req = urllib.request.Request(self.base + "/api/start", data=b'{"email":"x@y.z"}',
                                     headers={"Content-Type": "application/json"}, method="POST")
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req)
        self.assertEqual(e.exception.code, 403)

    def test_healthz(self):
        self.assertEqual(json.loads(self.get("/healthz").read())["ok"], True)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3:** Run → FAIL.

- [ ] **Step 4: Server** — `tracker/portal/server.py`:

```python
"""Tag export portal — phone-facing HTTP on 127.0.0.1 behind Cloudflare Tunnel.

Run: cd tracker && .venv/bin/python -m portal.server
Env: API_URL, TRACKER_INGEST_KEY, EXPORTER_BIN (default ~/Dev/export-findmy/target/release/export-findmy),
     PORTAL_PORT (8765).
"""
from __future__ import annotations

import json
import logging
import os
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from portal.session import ExportSession, SessionConfig
from portal.taskz_client import TaskzClient

VERSION = "1"
STATIC = Path(__file__).parent / "static" / "index.html"
COOKIE = "tz_portal"
COOKIE_AGE = 900
RATE_LIMIT = 10  # link checks per minute per client IP
log = logging.getLogger("portal")


class Portal:
    def __init__(self, cfg: SessionConfig, client, secure_cookie: bool = True):
        self.cfg = cfg
        self.client = client
        self.secure_cookie = secure_cookie
        self.visitors: dict[str, dict] = {}   # cookie -> {"invite": {...}, "session": ExportSession|None, "at": t}
        self.active: ExportSession | None = None
        self.hits: dict[str, list] = {}
        self.lock = threading.Lock()

    def rate_ok(self, ip: str) -> bool:
        now = time.monotonic()
        with self.lock:
            recent = [t for t in self.hits.get(ip, []) if now - t < 60]
            recent.append(now)
            self.hits[ip] = recent
            return len(recent) <= RATE_LIMIT

    def reap(self) -> None:
        with self.lock:
            if self.active is not None:
                self.active.reap()
                if self.active.finished:
                    self.active = None
            cutoff = time.monotonic() - COOKIE_AGE
            for k in [k for k, v in self.visitors.items() if v["at"] < cutoff]:
                del self.visitors[k]


def make_handler(portal: Portal):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # never log bodies or query strings
            log.info("%s %s", self.command, self.path.split("?")[0].split("/i/")[0] or "/i/…")

        def _headers(self, code=200, ctype="application/json", extra=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()

        def _json(self, obj, code=200):
            self._headers(code)
            self.wfile.write(json.dumps(obj).encode())

        def _visitor(self):
            raw = self.headers.get("Cookie", "")
            for part in raw.split(";"):
                k, _, v = part.strip().partition("=")
                if k == COOKIE:
                    return v, portal.visitors.get(v)
            return None, None

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}") if n <= 10000 else {}

        def do_GET(self):
            portal.reap()
            if self.path == "/healthz":
                return self._json({"ok": True, "version": VERSION})
            if self.path.startswith("/i/"):
                ip = self.headers.get("CF-Connecting-IP") or self.client_address[0]
                token = self.path[3:].split("?")[0]
                res = portal.client.check(token) if portal.rate_ok(ip) else {"ok": False}
                if res.get("ok"):
                    inv = res
                    cookie = secrets.token_urlsafe(24)
                    portal.visitors[cookie] = {"invite": inv, "session": None, "at": time.monotonic()}
                    flags = f"{COOKIE}={cookie}; Path=/; Max-Age={COOKIE_AGE}; HttpOnly; SameSite=Strict"
                    if portal.secure_cookie:
                        flags += "; Secure"
                    self._headers(303, "text/plain", {"Location": "/", "Set-Cookie": flags})
                else:
                    self._headers(303, "text/plain", {"Location": "/?expired=1"})
                return
            if self.path.startswith("/api/state"):
                _, v = self._visitor()
                if not v:
                    return self._json({"step": "expired"})
                v["at"] = time.monotonic()
                if v["session"] is None:
                    return self._json({"step": "intro", "label": v["invite"]["label"]})
                return self._json(v["session"].state)
            if self.path == "/" or self.path.startswith("/?"):
                self._headers(200, "text/html; charset=utf-8")
                self.wfile.write(STATIC.read_bytes())
                return
            self._headers(404, "text/plain")

        def do_POST(self):
            portal.reap()
            _, v = self._visitor()
            if not v:
                return self._json({"error": "no session"}, 403)
            v["at"] = time.monotonic()
            body = self._body()
            if self.path == "/api/start":
                email = str(body.get("email") or "").strip()
                if "@" not in email or len(email) > 200:
                    return self._json({"step": "intro", "label": v["invite"]["label"], "message": "Enter your Apple ID email."})
                with portal.lock:
                    if portal.active is not None and not portal.active.finished and portal.active is not v["session"]:
                        return self._json({"step": "busy"})
                    s = ExportSession(v["invite"], email, portal.cfg, portal.client)
                    v["session"] = s
                    portal.active = s
                return self._json(s.start())
            s = v["session"]
            if s is None:
                return self._json({"error": "not started"}, 409)
            if self.path == "/api/answer":
                return self._json(s.answer(str(body.get("value") or "")))
            if self.path == "/api/save":
                return self._json(s.save([str(f) for f in body.get("files") or []]))
            if self.path == "/api/cancel":
                return self._json(s.cancel())
            self._json({"error": "not found"}, 404)

    return Handler


def make_server(cfg: SessionConfig, client, host: str = "127.0.0.1", port: int = 8765,
                secure_cookie: bool = True) -> ThreadingHTTPServer:
    portal = Portal(cfg, client, secure_cookie=secure_cookie)
    return ThreadingHTTPServer((host, port), make_handler(portal))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    tracker = Path(__file__).resolve().parent.parent
    exporter = os.environ.get("EXPORTER_BIN", str(Path.home() / "Dev/export-findmy/target/release/export-findmy"))
    cfg = SessionConfig(
        exporter_argv=[exporter],
        template_profile=Path(exporter).parents[2] / "device-profile.template.toml",
        shared_root=tracker / "accounts" / "shared",
        work_root=Path.home() / "Library" / "Application Support" / "taskz-portal",
    )
    client = TaskzClient(os.environ["API_URL"], os.environ["TRACKER_INGEST_KEY"])
    httpd = make_server(cfg, client, port=int(os.environ.get("PORTAL_PORT", "8765")))
    log.info("portal listening on 127.0.0.1:%s", httpd.server_address[1])
    httpd.serve_forever()


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Page** — `tracker/portal/static/index.html`: one self-contained page (inline CSS/JS, no external assets). Screens keyed by `state.step`:
  - `expired` — "This link has expired or was already used. Ask the office for a new one."
  - `intro` — heading "Add your tags", bullet list: Apple will show "a new Mac signed in" (expected); you'll be asked for your iPhone passcode so the tag keys can be read from iCloud Keychain; only the tags you choose are kept, everything else is deleted straight after. Email input + Start.
  - `busy` — "Someone else is adding tags right now. Try again in a few minutes." + Retry.
  - `need_password` — password input (`autocomplete="current-password"`), optional `message`.
  - `need_2fa_method` — one button per `options[].label`, sends `index`.
  - `need_code` — numeric input (`inputmode="numeric" autocomplete="one-time-code"`).
  - `need_bottle` — "Which of your devices do you know the passcode for?" buttons from options.
  - `need_passcode` — "Enter the passcode of {device}" + why; password input.
  - `choose` — checkbox list (`items`), tags first, devices under "Your devices" (unticked); Save.
  - `done` — "Done — {saved} tag(s) added." + "On your iPhone: Settings → your name → scroll to the device list → remove '{remove_device}'."
  - `error` — message by `error`: `bad_password` "Apple didn't accept that password.", `bad_code` "That code didn't work.", `hardware_key` "This Apple ID uses a security key, which this can't work with — ask the office.", `apple_unavailable` "Apple isn't responding — try again in 15 minutes.", `no_bottles` "Turn on iCloud Keychain on an iPhone with a passcode, then try again.", `no_items` "No tags found on this Apple ID.", `timeout` "This took too long, so we stopped.", `cancelled` "Cancelled.", default "Something went wrong — ask the office." Plus the remove-device line when `remove_device` is set, and "Open your link again to retry" unless `no_items`.
  Behaviour: `load()` GETs `/api/state` on start; every submit POSTs and renders the returned state; buttons disable and show "Working…" while a request is in flight (steps can take 10–30 s); inputs are cleared after each submit. A Cancel link on every in-progress step POSTs `/api/cancel`.

- [ ] **Step 6:** Tests → PASS (`.venv/bin/python -m unittest discover -s portal/tests -t .`). Commit `feat(tracker): export portal HTTP server and phone page`.

---

### Task 6: Sync — shared accounts and portal health

**Files:** Modify `tracker/sync_airtags.py`, `tracker/test_sync.py`.

- [ ] **Step 1: Failing tests** — append to `tracker/test_sync.py`:

```python
import tempfile
from pathlib import Path


class SharedAccounts(unittest.TestCase):
    def test_shared_dirs_are_listed_with_prefix(self):
        root = Path(tempfile.mkdtemp())
        (root / "droneops").mkdir()
        (root / "shared" / "sam-wa-abc123" / "keys").mkdir(parents=True)
        with mock.patch.object(s, "ACCOUNTS_ROOT", root):
            names = [s.slug_of(p) for p in s.list_accounts()]
        self.assertEqual(names, ["droneops", "shared/sam-wa-abc123"])

    def test_portal_health_reports_down_when_unreachable(self):
        with mock.patch.object(s, "PORTAL_URL", "http://127.0.0.1:9"):
            self.assertEqual(s.portal_health(), {"ok": False, "version": ""})
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement** in `sync_airtags.py`:
  - Constants: `LOOKUP_ACCOUNT = os.environ.get("LOOKUP_ACCOUNT") or "droneops"`, `PORTAL_URL = os.environ.get("PORTAL_HEALTH_URL") or "http://127.0.0.1:8765"`.
  - `slug_of(p)`: `f"shared/{p.name}"` when `p.parent.name == "shared"`, else `p.name`.
  - `list_accounts(only)`: normal dirs except `shared`, plus sorted `ACCOUNTS_ROOT/"shared"/*` dirs; filter `only` by `slug_of`.
  - `load_account(acct_dir, lookup=None)`: when `acct_dir.parent.name == "shared"`, don't read a session — return `(lookup, pairs)`, raising `AccountError(f"[{slug}] no {LOOKUP_ACCOUNT} session for shared keys")` if `lookup` is None. Use `slug_of` for messages.
  - `portal_health()`: GET `PORTAL_URL + "/healthz"` with 3 s timeout → `{"ok": True, "version": body["version"]}`; any exception → `{"ok": False, "version": ""}`.
  - `post_inventory(rows, portal=None)`: include `"portal": portal` in the body when given.
  - `main`: load non-shared accounts first; `lookup = the LOOKUP_ACCOUNT account object if loaded`; then shared dirs with `load_account(d, lookup)`; call `post_inventory(rows, portal_health())`; `loaded.append((slug_of(d), …))`.

- [ ] **Step 4:** `.venv/bin/python -m unittest test_sync` → PASS. Commit `feat(tracker): locate shared portal keys with the droneops session`.

---

### Task 7: Ops, docs, verification

- [ ] **Step 1: launchd** — `tracker/com.buzzbot.tracker-portal.plist` (repo copy has placeholder key):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.buzzbot.tracker-portal</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/buzzbot/Dev/Ops-Schedule/tracker/.venv/bin/python</string>
    <string>-m</string><string>portal.server</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/buzzbot/Dev/Ops-Schedule/tracker</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>API_URL</key><string>https://taskz.id</string>
    <key>TRACKER_INGEST_KEY</key><string>REPLACE_WITH_SERVER_TRACKER_INGEST_KEY</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/Users/buzzbot/Library/Logs/airtag-tracker/portal.log</string>
  <key>StandardErrorPath</key><string>/Users/buzzbot/Library/Logs/airtag-tracker/portal.err.log</string>
</dict>
</plist>
```

Install: copy to `~/Library/LaunchAgents/`, set the key from the sync plist with PlistBuddy, `chmod 600`, `launchctl load`. Check `curl -s 127.0.0.1:8765/healthz`.

- [ ] **Step 2: Tunnel** — add `tags.keyz.au → http://127.0.0.1:8765` to the running keyz.au tunnel's ingress (before its catch-all), `cloudflared tunnel route dns <tunnel> tags.keyz.au`, restart that tunnel. Check `curl -s https://tags.keyz.au/healthz`. (Outward-facing DNS change — confirm with the user before running.)

- [ ] **Step 3: Server** — add `SetEnv TRACKER_PORTAL_URL https://tags.keyz.au` to `public_html/.htaccess` via `ssh tagz-host` (backup first), then kill the `lsnode:` process. Check Settings shows the Portal tile and Invites section, and the Mac setup section is gone.

- [ ] **Step 4: README** — add a "Phone export portal" section to `tracker/README.md`: install pexpect, the plist, the tunnel line, `TRACKER_PORTAL_URL`, where temp files live (`~/Library/Application Support/taskz-portal`), and the manual recovery for "Cleanup needed" (run `export_keys.sh`-style `--delete-own-escrow-bottle` with that person, remove "Taskz Tag Export" from their devices).

- [ ] **Step 5: E2E** — the user runs one export on their phone with a spare Apple ID via a real invite. Record Apple's real error strings seen during the run (if any) and update `ERROR_PATTERNS` + fake exporter to match. Confirm: bottle deleted, temp dir empty, Mac listed under that Apple ID's devices, chosen tags appear excluded in Settings under `shared/<slug>`.

- [ ] **Step 6:** Commit, push (deploys), verify live bundle hash.
