# Equipment Planning Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Moves / Sitting-idle strip, usage %, and a "near a place" filter to the V2 Equipment tab.

**Architecture:** Pure rule functions extend `client-v2/src/lib/equipmentPlan.js`; a cached, rate-limited `GET /api/geocode` resolves typed towns; `EquipmentView` wires rules into the planning bar (Near box), a new `MovesStrip`, row chips, group usage and two map overlays (route arrow, near circle).

**Tech Stack:** React 18 + Vite, Leaflet 1.9, Express + `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-28-equipment-planning-phase2-design.md`

## Global Constraints

- `ROAD_FACTOR = 1.3`, `KM_PER_DAY = 800`, `MOVE_LOOKAHEAD_DAYS = 14`, `SAME_SITE_KM = 1`, `BASE_MOVE_KM = 250`, `TAG_SITE_KM = 50`, `NOT_RETURNED_DAYS = 3`, `USAGE_DAYS = 30`.
- `gapDays` = days strictly between leaving and due (2 Oct → 6 Oct = 3). Tight when `km != null && gapDays < needDays`, `needDays = max(1, ceil(km / 800))`.
- Town lookup: 24 h cache (max 500), 30 lookups/min per user → 429, query 1–120 chars.
- Near radius options 100 / 250 / 500 / 1000 km, default 500; stored in `plan.near`.
- `npm test` at repo root must pass after every task.

---

### Task 1: Rules

**Produces:** `haversineKm(a, b)`, `jobRuns(booked)`, `movesFor(item, {runs, jobsById, win, today})`, `tagChecks(item, {ping, staleDays, runs, jobsById, today, nowMs})`, `usagePct(booked, today)`, `isIdle(item, booked, today)`, `lastUsed(booked, today)`, `nearFilter(rows, place, radiusKm)`, constants above.

- [ ] **Step 1: Failing tests** — append to `client-v2/test/equipmentPlan.test.js`:

```js
import {
  haversineKm, jobRuns, movesFor, tagChecks, usagePct, isIdle, lastUsed, nearFilter,
} from '../src/lib/equipmentPlan.js';

const J = new Map([
  ['a', { id: 'a', code: 'TST1', site_address: 'Muswellbrook NSW', site_lat: -32.27, site_lng: 150.89, state: 'NSW' }],
  ['b', { id: 'b', code: 'J2395', site_address: 'Millar Road Baldivis', site_lat: -32.28, site_lng: 115.83, state: 'WA' }],
  ['c', { id: 'c', code: 'J2396', site_address: 'Muswellbrook NSW', site_lat: -32.27, site_lng: 150.89, state: 'NSW' }],
  ['n', { id: 'n', code: 'NOPOS', site_address: '', state: 'WA' }],
  ['k', { id: 'k', code: 'J2216', site_address: 'Karratha Gas Plant', site_lat: -20.59, site_lng: 116.78, state: 'WA' }],
]);
const days = (job, from, to) => {
  const out = [];
  for (let d = from; d <= to; d = new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10)) out.push(e('x', d, job));
  return out;
};
const W = { from: '2026-10-01', to: '2026-10-14' };

test('haversine: Perth to Sydney is about 3,290 km', () => {
  const km = haversineKm({ lat: -31.95, lng: 115.86 }, { lat: -33.87, lng: 151.21 });
  assert.ok(km > 3250 && km < 3320, String(km));
});

test('jobRuns splits on job change and on gaps', () => {
  const b = bookedIndex([...days('a', '2026-10-01', '2026-10-02'), ...days('a', '2026-10-05', '2026-10-05'), ...days('b', '2026-10-06', '2026-10-07')]).get('x');
  assert.deepEqual(jobRuns(b).map((r) => [r.jobId, r.from, r.to]),
    [['a', '2026-10-01', '2026-10-02'], ['a', '2026-10-05', '2026-10-05'], ['b', '2026-10-06', '2026-10-07']]);
});

test('a move between different sites, with distance, gap and tightness', () => {
  const b = bookedIndex([...days('a', '2026-09-28', '2026-10-02'), ...days('b', '2026-10-06', '2026-10-08')]).get('x');
  const [m] = movesFor({ id: 'x' }, { runs: jobRuns(b), jobsById: J, win: W, today: '2026-10-01' });
  assert.equal(m.from.label, 'TST1 Muswellbrook NSW');
  assert.equal(m.to.label, 'J2395 Millar Road Baldivis');
  assert.deepEqual([m.leaveAfter, m.dueBy, m.gapDays], ['2026-10-02', '2026-10-06', 3]);
  assert.ok(m.km > 4000 && m.km % 10 === 0, String(m.km));
  assert.equal(m.needDays, Math.ceil(m.km / 800));
  assert.equal(m.tight, true);
});

test('same site back-to-back is not a move; unknown position falls back to state', () => {
  const same = bookedIndex([...days('a', '2026-10-01', '2026-10-02'), ...days('c', '2026-10-04', '2026-10-05')]).get('x');
  assert.deepEqual(movesFor({ id: 'x' }, { runs: jobRuns(same), jobsById: J, win: W, today: '2026-10-01' }), []);
  const nopos = bookedIndex([...days('a', '2026-10-01', '2026-10-02'), ...days('n', '2026-10-09', '2026-10-10')]).get('x');
  const [m] = movesFor({ id: 'x' }, { runs: jobRuns(nopos), jobsById: J, win: W, today: '2026-10-01' });
  assert.deepEqual([m.km, m.tight], [null, false]);
});

test('moves only when the next job starts within the window plus 14 days', () => {
  const late = bookedIndex([...days('a', '2026-10-01', '2026-10-02'), ...days('b', '2026-10-29', '2026-10-30')]).get('x');
  assert.equal(movesFor({ id: 'x' }, { runs: jobRuns(late), jobsById: J, win: W, today: '2026-10-01' }).length, 0);
  const edge = bookedIndex([...days('a', '2026-10-01', '2026-10-02'), ...days('b', '2026-10-28', '2026-10-28')]).get('x');
  assert.equal(movesFor({ id: 'x' }, { runs: jobRuns(edge), jobsById: J, win: W, today: '2026-10-01' }).length, 1);
});

test('a first job far from the home base is a base move; near the base is not', () => {
  const far = bookedIndex(days('k', '2026-10-05', '2026-10-07')).get('x');
  const [m] = movesFor({ id: 'x', location: 'WA' }, { runs: jobRuns(far), jobsById: J, win: W, today: '2026-10-01' });
  assert.equal(m.from.label, 'WA base (Perth)');
  assert.equal(m.to.label, 'J2216 Karratha Gas Plant');
  assert.equal(m.leaveAfter, null);
  assert.equal(m.gapDays, 4);
  const near = bookedIndex(days('b', '2026-10-05', '2026-10-07')).get('x');
  assert.equal(movesFor({ id: 'x', location: 'WA' }, { runs: jobRuns(near), jobsById: J, win: W, today: '2026-10-01' }).length, 0);
});

test('tight boundary: gap equal to need is fine', () => {
  // Karratha → Baldivis ≈ 1,300 km × 1.3 ≈ 1,700 km → needs 3 days
  const b = bookedIndex([...days('k', '2026-10-01', '2026-10-02'), ...days('b', '2026-10-06', '2026-10-06')]).get('x');
  const [m] = movesFor({ id: 'x' }, { runs: jobRuns(b), jobsById: J, win: W, today: '2026-10-01' });
  assert.equal(m.gapDays, 3);
  assert.equal(m.needDays, 3);
  assert.equal(m.tight, false);
});

test('tag checks: not at site, not returned, and nothing for a stale ping', () => {
  const now = Date.parse('2026-10-03T01:00:00Z');
  const onJob = jobRuns(bookedIndex(days('a', '2026-10-01', '2026-10-05')).get('x'));
  const far = { lat: -31.95, lng: 115.86, seen_at: '2026-10-03T00:00:00Z' };
  const [c] = tagChecks({ id: 'x' }, { ping: far, staleDays: 3, runs: onJob, jobsById: J, today: '2026-10-03', nowMs: now });
  assert.equal(c.kind, 'not_at_site');
  const ended = jobRuns(bookedIndex(days('a', '2026-09-25', '2026-09-29')).get('x'));
  const atSite = { lat: -32.27, lng: 150.9, seen_at: '2026-10-03T00:00:00Z' };
  const [r] = tagChecks({ id: 'x' }, { ping: atSite, staleDays: 3, runs: ended, jobsById: J, today: '2026-10-03', nowMs: now });
  assert.equal(r.kind, 'not_returned');
  const stale = { ...far, seen_at: '2026-09-20T00:00:00Z' };
  assert.deepEqual(tagChecks({ id: 'x' }, { ping: stale, staleDays: 3, runs: onJob, jobsById: J, today: '2026-10-03', nowMs: now }), []);
});

test('usage over the last 30 days, idle, last used', () => {
  const b = bookedIndex([...days('a', '2026-09-01', '2026-09-15'), ...days('a', '2026-10-01', '2026-10-01')]).get('x');
  assert.equal(usagePct(b, '2026-10-01'), 50); // 1–15 Sep inside 1 Sep..30 Sep = 15/30
  assert.equal(usagePct(b, '2026-10-02'), 50); // 2 Sep..1 Oct: 14 + 1
  assert.equal(usagePct(undefined, '2026-10-01'), 0);
  assert.equal(lastUsed(b, '2026-10-01'), '2026-09-15');
  const old = bookedIndex(days('a', '2026-08-01', '2026-08-05')).get('x');
  assert.equal(isIdle({ id: 'x' }, old, '2026-10-01'), true);
  assert.equal(isIdle({ id: 'x' }, b, '2026-10-01'), false);
  assert.equal(isIdle({ id: 'x', active: 0 }, old, '2026-10-01'), false);
  assert.equal(isIdle({ id: 'x', serviceable: 0 }, old, '2026-10-01'), false);
});

test('nearFilter keeps rows within the radius, nearest first', () => {
  const rows = [
    { id: 'p', loc: { lat: -31.95, lng: 115.86 } },
    { id: 'k', loc: { lat: -20.59, lng: 116.78 } },
    { id: 'u', loc: { lat: null, lng: null } },
  ];
  const out = nearFilter(rows, { lat: -32.28, lng: 115.83 }, 500);
  assert.deepEqual(out.map((r) => r.id), ['p']);
  assert.ok(out[0].distKm < 50);
  assert.deepEqual(nearFilter(rows, { lat: -32.28, lng: 115.83 }, 1500).map((r) => r.id), ['p', 'k']);
});
```

- [ ] **Step 2:** `node --test client-v2/test/equipmentPlan.test.js` → FAIL.

- [ ] **Step 3: Implement** — append to `client-v2/src/lib/equipmentPlan.js`:

```js
// ── Phase 2: moves, tag checks, usage, near a place ─────────────────────
export const ROAD_FACTOR = 1.3;
export const KM_PER_DAY = 800;
export const MOVE_LOOKAHEAD_DAYS = 14;
export const SAME_SITE_KM = 1;
export const BASE_MOVE_KM = 250;
export const TAG_SITE_KM = 50;
export const NOT_RETURNED_DAYS = 3;
export const USAGE_DAYS = 30;

export function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function jobRuns(booked) {
  const runs = [];
  for (const d of [...(booked?.keys() || [])].sort()) {
    const en = booked.get(d);
    const last = runs[runs.length - 1];
    if (last && last.jobId === en.job_id && diffDays(last.to, d) === 1) last.to = d;
    else runs.push({ jobId: en.job_id, code: en.job_code, from: d, to: d });
  }
  return runs;
}

function sitePoint(job, code) {
  const s = siteOf(job);
  return {
    label: `${job?.code || code || 'job'}${s.where ? ` ${s.where}` : ''}`,
    lat: s.lat, lng: s.lng, jobId: job?.id || null, state: job?.state || '',
  };
}

function differentSite(a, b) {
  if (a.lat != null && b.lat != null) return haversineKm(a, b) > SAME_SITE_KM;
  return a.state !== b.state;
}

function makeMove(itemId, from, to, leaveAfter, dueBy, gapDays) {
  const km = from.lat != null && to.lat != null
    ? Math.round((haversineKm(from, to) * ROAD_FACTOR) / 10) * 10 : null;
  const needDays = km == null ? null : Math.max(1, Math.ceil(km / KM_PER_DAY));
  return { itemId, from, to, leaveAfter, dueBy, gapDays, km, needDays, tight: km != null && gapDays < needDays };
}

export function movesFor(item, { runs, jobsById, win, today }) {
  const until = addDays(win.to, MOVE_LOOKAHEAD_DAYS);
  const inRange = (d) => d >= win.from && d <= until;
  const out = [];
  for (let i = 1; i < runs.length; i++) {
    const a = runs[i - 1];
    const b = runs[i];
    if (a.jobId === b.jobId || !inRange(b.from)) continue;
    const from = sitePoint(jobsById?.get(a.jobId), a.code);
    const to = sitePoint(jobsById?.get(b.jobId), b.code);
    if (!differentSite(from, to)) continue;
    out.push(makeMove(item.id, from, to, a.to, b.from, diffDays(a.to, b.from) - 1));
  }
  const firstIdx = runs.findIndex((r) => inRange(r.from));
  const base = BASE_CITIES[item.location];
  if (firstIdx >= 0 && base) {
    const first = runs[firstIdx];
    const prev = runs[firstIdx - 1];
    const recent = prev && diffDays(prev.to, first.from) <= LAST_JOB_DAYS;
    const to = sitePoint(jobsById?.get(first.jobId), first.code);
    if (!recent && to.lat != null && haversineKm(base, to) > BASE_MOVE_KM) {
      const from = { label: `${item.location} base (${base.city})`, lat: base.lat, lng: base.lng, jobId: null, state: item.location };
      out.unshift(makeMove(item.id, from, to, null, first.from, Math.max(0, diffDays(today, first.from))));
    }
  }
  return out;
}

export function tagChecks(item, { ping, staleDays = 3, runs, jobsById, today, nowMs = Date.now() }) {
  if (!ping?.seen_at || !Number.isFinite(ping.lat) || nowMs - Date.parse(ping.seen_at) > staleDays * 86400000) return [];
  const current = runs.find((r) => r.from <= today && r.to >= today);
  if (current) {
    const s = sitePoint(jobsById?.get(current.jobId), current.code);
    if (s.lat == null) return [];
    const km = Math.round(haversineKm(ping, s));
    return km > TAG_SITE_KM
      ? [{ itemId: item.id, kind: 'not_at_site', km, text: `booked on ${s.label} today, tag ${km} km away` }]
      : [];
  }
  const last = runs.filter((r) => r.to < today).pop();
  if (!last) return [];
  const ago = diffDays(last.to, today);
  const s = sitePoint(jobsById?.get(last.jobId), last.code);
  if (ago >= NOT_RETURNED_DAYS && s.lat != null && haversineKm(ping, s) <= TAG_SITE_KM) {
    return [{ itemId: item.id, kind: 'not_returned', text: `still at ${s.label}, job ended ${ago} days ago` }];
  }
  return [];
}

export function usagePct(booked, today) {
  let n = 0;
  for (const d of booked?.keys() || []) {
    const back = diffDays(d, today);
    if (back >= 1 && back <= USAGE_DAYS) n += 1;
  }
  return Math.round((100 * n) / USAGE_DAYS);
}

export function isIdle(item, booked, today) {
  if (item.serviceable === 0 || item.active === 0) return false;
  for (const d of booked?.keys() || []) {
    const off = diffDays(today, d);
    if (off >= -USAGE_DAYS && off < USAGE_DAYS) return false;
  }
  return true;
}

export function lastUsed(booked, today) {
  return [...(booked?.keys() || [])].filter((d) => d < today).sort().pop() || null;
}

export function nearFilter(rows, place, radiusKm) {
  return rows
    .filter((r) => r.loc?.lat != null && r.loc?.lng != null)
    .map((r) => ({ ...r, distKm: Math.round(haversineKm(place, r.loc)) }))
    .filter((r) => r.distKm <= radiusKm)
    .sort((a, b) => a.distKm - b.distKm);
}
```

`diffDays(a, b)` in `lib/dates.js` returns `b − a` in days — check before relying on the sign; `isIdle` uses `diffDays(today, d)` so dates after today are positive.

- [ ] **Step 4:** tests pass; `npm test`; commit `feat(v2): phase 2 rules — moves, tag checks, usage, near`.

---

### Task 2: Town lookup endpoint

**Produces:** `GET /api/geocode?q=` → `{found, lat, lng, label}`; `geocodePlace(q, opts)`; `setPlaceLookup(fn|null)` for tests.

- [ ] **Step 1: Failing tests** — `server/test/geocodeLookup.test.js`:

```js
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initDb } from '../src/db.js';
import { signToken, requireAuth } from '../src/middleware/auth.js';
import geocodeRoutes, { setPlaceLookup } from '../src/routes/geocode.js';
import { geocodePlace } from '../src/services/geocodeSite.js';

let db, server, base, dbPath, cookie, calls;

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-')), 'test.db');
  process.env.DATABASE_PATH = dbPath;
  db = initDb();
  const app = express();
  app.use(cookieParser());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/geocode', requireAuth, geocodeRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/geocode`;
});

after(() => {
  setPlaceLookup(null);
  server?.close();
  db?.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM team_members WHERE id LIKE 'm%'");
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m1','Alex',0,1)").run();
  cookie = `auth_token=${signToken('m1', false)}`;
  calls = 0;
  setPlaceLookup(async (q) => { calls += 1; return q.toLowerCase().includes('hedland') ? { lat: -20.31, lng: 118.6, label: 'Port Hedland, Western Australia' } : null; });
});

const get = (q) => fetch(`${base}?q=${encodeURIComponent(q)}`, { headers: { cookie } });

test('finds a town and caches it', async () => {
  assert.deepEqual(await (await get('Port Hedland')).json(), { found: true, lat: -20.31, lng: 118.6, label: 'Port Hedland, Western Australia' });
  await get('  port hedland ');
  assert.equal(calls, 1);
});

test('not found, and bad queries', async () => {
  assert.deepEqual(await (await get('Nowhereville')).json(), { found: false });
  assert.equal((await get('')).status, 400);
  assert.equal((await get('x'.repeat(121))).status, 400);
});

test('limits uncached lookups to 30 a minute per user', async () => {
  for (let i = 0; i < 30; i++) assert.equal((await get(`town ${i}`)).status, 200);
  assert.equal((await get('town 31')).status, 429);
});

test('needs a signed-in user', async () => {
  assert.equal((await fetch(`${base}?q=perth`)).status, 401);
});

test('geocodePlace returns a label from Photon properties', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ features: [{ geometry: { coordinates: [118.6, -20.31] }, properties: { name: 'Port Hedland', state: 'Western Australia' } }] }) });
  assert.deepEqual(await geocodePlace('x', { fetchImpl }), { lat: -20.31, lng: 118.6, label: 'Port Hedland, Western Australia' });
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Service** — in `server/src/services/geocodeSite.js` rename the body of `geocodeAddress` into `geocodePlace` returning `{lat, lng, label}` where `label = [p.name, p.state].filter(Boolean).join(', ')` from `features[0].properties`; keep `geocodeAddress` as a wrapper returning `{lat, lng}` (existing tests must keep passing).
- [ ] **Step 4: Route** — `server/src/routes/geocode.js`:

```js
import { Router } from 'express';
import { geocodePlace } from '../services/geocodeSite.js';

// Town lookup for the equipment "Near" filter. Cached for a day and limited
// per user so typing cannot hammer the free Photon service.
const router = Router();
const TTL_MS = 24 * 3600 * 1000;
const MAX_CACHE = 500;
const PER_MINUTE = 30;
const cache = new Map();
const hits = new Map();
let lookup = (q) => geocodePlace(q);

export function setPlaceLookup(fn) {
  lookup = fn || ((q) => geocodePlace(q));
  cache.clear();
  hits.clear();
}

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q || q.length > 120) return res.status(400).json({ error: 'Type a place name' });
  const key = q.toLowerCase();
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < TTL_MS) return res.json(cached.value);

  const who = req.user?.memberId || req.ip;
  const recent = (hits.get(who) || []).filter((t) => now - t < 60000);
  if (recent.length >= PER_MINUTE) return res.status(429).json({ error: 'Too many lookups — try again shortly' });
  recent.push(now);
  hits.set(who, recent);

  const pos = await lookup(q);
  const value = pos ? { found: true, lat: pos.lat, lng: pos.lng, label: pos.label || q } : { found: false };
  cache.set(key, { at: now, value });
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  res.json(value);
});

export default router;
```

Mount in `index.js` and `server/src/index.js`: `import geocodeRoutes from './…/routes/geocode.js'` and `app.use('/api/geocode', requireAuth, geocodeRoutes);` next to the other `/api` mounts.

- [ ] **Step 5:** tests pass; `npm test`; commit `feat(api): cached town lookup for the equipment Near filter`.

---

### Task 3: Screen

**Files:** `client-v2/src/api.js`, `client-v2/src/components/PlanningBar.jsx`, `client-v2/src/components/MovesStrip.jsx` (new), `client-v2/src/components/EquipmentView.jsx`, `client-v2/src/components/EquipmentMapPanel.jsx`, `client-v2/src/styles.css`.

- [ ] **Step 1: API** — `export const geocodePlace = (q) => api(`/geocode?q=${encodeURIComponent(q)}`);`
- [ ] **Step 2: Near box** — in `PlanningBar`, accept `jobs` (with site positions) and render after Free only:

```jsx
      <NearBox near={plan.near} jobs={jobs} onNear={(near) => set({ near })} />
```

with, in the same file:

```jsx
import { geocodePlace } from '../api.js';

const RADII = [100, 250, 500, 1000];

function NearBox({ near, jobs, onNear }) {
  const [text, setText] = React.useState('');
  const [msg, setMsg] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const options = (jobs || []).filter((j) => Number.isFinite(j.site_lat))
    .map((j) => ({ key: `${j.code} ${j.site_address || j.name}`, lat: j.site_lat, lng: j.site_lng }));

  const choose = async () => {
    const q = text.trim();
    if (!q) return;
    const job = options.find((o) => o.key.toLowerCase() === q.toLowerCase());
    if (job) { onNear({ label: job.key, lat: job.lat, lng: job.lng, radius: near?.radius || 500 }); setText(''); setMsg(''); return; }
    setBusy(true);
    try {
      const r = await geocodePlace(q);
      if (r.found) { onNear({ label: r.label, lat: r.lat, lng: r.lng, radius: near?.radius || 500 }); setText(''); setMsg(''); }
      else setMsg(`Couldn't find "${q}" — try a nearby town or pick a job`);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (near) {
    return (
      <span className="near">
        <span className="near-label">Near <strong>{near.label}</strong></span>
        {RADII.map((r) => (
          <button key={r} type="button" className={`chip${near.radius === r ? ' is-active' : ''}`}
            onClick={() => onNear({ ...near, radius: r })}>{r} km</button>
        ))}
        <button type="button" className="chip" onClick={() => onNear(null)} aria-label="Clear near">✕</button>
      </span>
    );
  }
  return (
    <span className="near">
      <input list="near-jobs" value={text} placeholder="Near a job or town…" aria-label="Near"
        onChange={(e) => {
          setText(e.target.value);
          const job = options.find((o) => o.key === e.target.value);
          if (job) { onNear({ label: job.key, lat: job.lat, lng: job.lng, radius: 500 }); setText(''); }
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') choose(); }} />
      <datalist id="near-jobs">{options.map((o) => <option key={o.key} value={o.key} />)}</datalist>
      <button type="button" className="chip" disabled={busy || !text.trim()} onClick={choose}>{busy ? '…' : 'Find'}</button>
      {msg && <span className="near-msg">{msg}</span>}
    </span>
  );
}
```

- [ ] **Step 3: MovesStrip** — `client-v2/src/components/MovesStrip.jsx`:

```jsx
import React, { useEffect, useState } from 'react';
import { fmtShort } from '../lib/dates.js';

// The transport list for the window, plus kit that has not moved in a month.
export default function MovesStrip({ moves, checks, idle, names, onSelect }) {
  const [open, setOpen] = useState(() => {
    try { return JSON.parse(localStorage.getItem('eq.strip') || '{}'); } catch { return {}; }
  });
  useEffect(() => { try { localStorage.setItem('eq.strip', JSON.stringify(open)); } catch { /* storage unavailable */ } }, [open]);
  const tight = moves.filter((m) => m.tight).length;
  const toggle = (k) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  return (
    <div className="moves">
      <div className="moves-head">
        <button type="button" className={`chip${open.moves ? ' is-active' : ''}`} onClick={() => toggle('moves')}>
          🚚 Moves ({moves.length + checks.length}){tight ? <span className="moves-tight"> · {tight} tight</span> : null}
          {checks.length ? <span className="moves-tight"> · {checks.length} ⚠</span> : null}
        </button>
        <button type="button" className={`chip${open.idle ? ' is-active' : ''}`} onClick={() => toggle('idle')}>
          💤 Sitting idle ({idle.length})
        </button>
      </div>
      {open.moves && (
        <div className="moves-list">
          {checks.length + moves.length === 0 && <div className="rl-sub">Nothing needs moving in this window.</div>}
          {checks.map((c) => (
            <button type="button" key={`${c.itemId}-${c.kind}`} className="moves-row is-tight" onClick={() => onSelect(c.itemId)}>
              ⚠ <strong>{names.get(c.itemId)}</strong> {c.kind === 'not_at_site' ? 'not at site' : 'not returned'} — {c.text}
            </button>
          ))}
          {moves.map((m) => (
            <button type="button" key={`${m.itemId}-${m.dueBy}-${m.to.jobId}`} className={`moves-row${m.tight ? ' is-tight' : ''}`}
              onClick={() => onSelect(m.itemId)}>
              <strong>{names.get(m.itemId)}</strong> · {m.from.label} → {m.to.label}
              {m.leaveAfter ? ` · leave after ${fmtShort(m.leaveAfter)}` : ''} · due {fmtShort(m.dueBy)}
              {' · '}{m.km != null ? `~${m.km.toLocaleString()} km · ${m.gapDays} day${m.gapDays === 1 ? '' : 's'}${m.tight ? ` (needs ${m.needDays})` : ''}` : 'distance unknown'}
            </button>
          ))}
        </div>
      )}
      {open.idle && (
        <div className="moves-list">
          {idle.length === 0 && <div className="rl-sub">Everything has been used in the last 30 days or is booked in the next 30.</div>}
          {idle.map((r) => (
            <button type="button" key={r.id} className="moves-row" onClick={() => onSelect(r.id)}>
              <strong>{r.item.name}</strong> · {r.loc.label} · {r.lastUsed ? `last used ${fmtShort(r.lastUsed)}` : 'not used in 30 days'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: EquipmentView wiring**
  - Imports: `jobRuns, movesFor, tagChecks, usagePct, isIdle, lastUsed, nearFilter, MOVE_LOOKAHEAD_DAYS, USAGE_DAYS` and `MovesStrip`.
  - `onEnsureRange`: start `min(addDays(win.from, -LAST_JOB_DAYS), addDays(today, -USAGE_DAYS))`, end `addDays(win.to, MOVE_LOOKAHEAD_DAYS)`.
  - Per row (in the rows map): `runs = jobRuns(booked.get(item.id))`; `moves = movesFor(item, {runs, jobsById, win, today})`; `checks = tagChecks(item, {ping, staleDays, runs, jobsById, today})`; `usage = usagePct(booked.get(item.id), today)`; `idle = isIdle(item, booked.get(item.id), today)`; `lastUsed = lastUsed(...)`. Add to the row object.
  - After Free only: `const nearRows = plan.near ? nearFilter(shown, plan.near, plan.near.radius) : shown;` use `nearRows` for buckets and `visible`; with Near on, bucket order = distance (don't re-sort with `sortRows`).
  - Group meta: `meta: <span className="rl-sub">{avg}%</span>` where avg = rounded mean of `usage` over the bucket's rows.
  - Aggregate for the strip over the rows **before** the Near filter but after status/search filters: `allMoves` (flatten, sort by `dueBy`), `allChecks`, `idleRows = rows.filter(r => r.idle)`, `names = Map(id → name)`.
  - Render `<MovesStrip … onSelect={onSelect} />` after `PlanningBar`; pass `jobs` to `PlanningBar`.
  - Label: after the availability chip add `{row.moves.length > 0 && <span className={`tag ${row.moves.some(m => m.tight) ? 'tag-danger' : 'tag-warn'}`}>🚚</span>}`, `{row.checks.length > 0 && <span className="tag tag-danger">⚠</span>}`, and `<span className="rl-sub">Used {row.usage}%</span>`; location line gets `· {row.distKm} km` when `row.distKm != null`.
  - Map props: `route` = the selected row's first move with both points known → `{from, to, label: `${leaveAfter ? `leave ${fmtShort(leaveAfter)} → ` : ''}due ${fmtShort(dueBy)}`}`; `near = plan.near`.
- [ ] **Step 5: Map overlays** — in `EquipmentMapPanel` add props `route`, `near`, an `overlay` layer group created on mount, and:

```jsx
  useEffect(() => {
    const g = overlay.current;
    const m = map.current;
    if (!g || !m) return;
    g.clearLayers();
    if (route) {
      L.polyline([[route.from.lat, route.from.lng], [route.to.lat, route.to.lng]], {
        color: '#e67700', weight: 3, dashArray: '8 6',
      }).bindTooltip(route.label, { permanent: true, direction: 'center', className: 'eqm-route' }).addTo(g);
    }
    if (near) {
      const c = L.circle([near.lat, near.lng], { radius: near.radius * 1000, color: '#3b5bdb', weight: 1, fillOpacity: 0.05 }).addTo(g);
      m.fitBounds(c.getBounds(), { padding: [20, 20] });
    }
  }, [route, near]);
```

- [ ] **Step 6: Styles** — append:

```css
.near { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 12px; }
.near input { width: 190px; }
.near-msg { color: var(--danger); font-size: 11px; }
.moves { padding: 4px 12px 6px; border-top: 1px solid var(--line-soft); }
.moves-head { display: flex; gap: 6px; flex-wrap: wrap; }
.moves-tight { color: var(--danger); font-weight: 600; }
.moves-list { display: grid; gap: 2px; margin-top: 6px; max-height: 220px; overflow: auto; }
.moves-row { text-align: left; background: none; border: 0; padding: 4px 6px; border-radius: 6px; font-size: 12px; color: var(--text); cursor: pointer; }
.moves-row:hover { background: var(--line-soft); }
.moves-row.is-tight { color: var(--danger); }
.eqm-route { background: #fff; color: #333; border: 0; font-size: 10px; padding: 1px 4px; }
```

- [ ] **Step 7:** `npm test`, build, browser (Near job + town + radius, Moves/Idle lists, click → selection + arrow, chips, usage in group headers, 375 px). Commit `feat(v2): moves, sitting-idle, usage and near-a-place on the equipment tab`.

---

### Task 4: Ship

- [ ] Merge to main (fetch first; merge any remote work), `npm test`, push (deploys), verify live bundle hash and the ingest key.
