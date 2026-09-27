# Equipment Planning View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the V2 Equipment tab, show for a chosen 1–2 week window which items are free and where each one is, with the timeline and a map side by side sharing one selection.

**Architecture:** Pure functions in `client-v2/src/lib/equipmentPlan.js` compute availability and a best-available location per item from data V2 already loads (equipment, schedule, jobs, latest pings). The server adds job-site coordinates (geocoded once on save) and a readable stale-days value. `EquipmentView` gains a planning bar, richer row labels, and a Leaflet map pane.

**Tech Stack:** React 18 + Vite (client-v2), Leaflet 1.9, Node/Express/better-sqlite3, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-28-equipment-planning-view-design.md`

## Global Constraints

- Location priority: tag (≤ stale days) → booked on window start → last job ended ≤ 14 days before window start → home base → unknown.
- Availability counts booked days incl. pad days; `serviceable === 0` → Unserviceable regardless.
- Window default: 14 days from today; options 7 / 14 / custom; persisted in `localStorage` key `eq.plan` (try/catch).
- Desktop split ≈62/38, divider + collapse persisted (`eq.mapWidth`, `eq.mapOpen`); under 768px a Timeline / Map toggle.
- Geocoding never blocks a job save; Photon with 5 s timeout; failure leaves no position.
- Leaflet `^1.9.4`; OSM tiles with attribution.
- Tests: `npm test` at repo root.

## File map

| File | Responsibility |
|---|---|
| `client-v2/src/lib/equipmentPlan.js` (create) | Booked-day index, availability, location resolution, sort, summary, text helpers |
| `client-v2/test/equipmentPlan.test.js` (create) | Tests for the above |
| `server/src/services/geocodeSite.js` (create) | Photon forward geocode + fire-and-forget job site update |
| `server/src/db.js` (modify) | `jobs.site_lat`, `site_lng`, `site_geocoded_address` |
| `server/src/routes/jobs.js` (modify) | Call geocode after create/update |
| `server/src/routes/equipment.js` (modify) | `GET /tracker/stale-days` |
| `server/test/jobSiteGeocode.test.js` (create) | Server tests |
| `scripts/geocode-job-sites.mjs` (create) | One-off backfill |
| `client-v2/src/components/Timeline.jsx` (modify) | `highlight` window shading; per-row `minHeight` |
| `client-v2/src/components/PlanningBar.jsx` (create) | Window picker, Free only, summary |
| `client-v2/src/components/EquipmentMapPanel.jsx` (create) | Leaflet map, pins, sites, trail, fit, not-on-map |
| `client-v2/src/components/EquipmentView.jsx` (modify) | Wire everything, shared selection, split layout |
| `client-v2/src/App.jsx`, `client-v2/src/api.js` (modify) | Pass `jobs`, `onEnsureRange`; new api calls |
| `client-v2/src/components/JobCard.jsx` (modify) | "Site not found on map" note |
| `client-v2/src/styles.css` (modify) | Split layout, chips, map |

---

### Task 1: Planning logic (`equipmentPlan.js`)

**Interfaces — Produces:**
- `BASE_CITIES: Record<string, {lat, lng, city}>`, `LAST_JOB_DAYS = 14`
- `bookedIndex(schedule) -> Map<itemId, Map<date, entry>>` (work entries only)
- `planWindow(preset: '7'|'14'|'custom', today, custom?: {from,to}) -> {from, to}`
- `availability(item, booked: Map|undefined, win) -> {status: 'free'|'partial'|'booked'|'unserviceable', freeDays, totalDays}`
- `availText(a) -> string`, `AVAIL_TONE`
- `resolveLocation(item, {ping, staleDays, booked, jobsById, windowStart, nowMs}) -> {source, label, lat, lng, approx, jobId}`
- `sortRows(rows)` (rows have `.avail` and `.item`), `summary(rows) -> {free, partial, booked, unserviceable}`

- [ ] **Step 1: Failing tests** — `client-v2/test/equipmentPlan.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bookedIndex, planWindow, availability, availText, resolveLocation, sortRows, summary, BASE_CITIES,
} from '../src/lib/equipmentPlan.js';

const e = (item, date, job = 'j1', status = 'tentative') => ({ team_member_id: item, date, job_id: job, status, job_code: 'HUN-24' });
const win = { from: '2026-10-01', to: '2026-10-14' };
const jobs = new Map([['j1', { id: 'j1', code: 'HUN-24', name: 'Hunter', site_address: 'Muswellbrook NSW', site_lat: -32.26, site_lng: 150.89, state: 'NSW' }]]);
const NOW = Date.parse('2026-10-01T02:00:00Z');

test('bookedIndex keeps work entries per item and date', () => {
  const idx = bookedIndex([e('a', '2026-10-02'), e('a', '2026-10-03'), { ...e('a', '2026-10-04'), status: 'leave' }]);
  assert.deepEqual([...idx.get('a').keys()], ['2026-10-02', '2026-10-03']);
});

test('planWindow presets and custom', () => {
  assert.deepEqual(planWindow('7', '2026-10-01'), { from: '2026-10-01', to: '2026-10-07' });
  assert.deepEqual(planWindow('14', '2026-10-01'), win);
  assert.deepEqual(planWindow('custom', '2026-10-01', { from: '2026-10-05', to: '2026-10-09' }), { from: '2026-10-05', to: '2026-10-09' });
  assert.deepEqual(planWindow('custom', '2026-10-01', { from: '2026-10-09', to: '2026-10-05' }), { from: '2026-10-05', to: '2026-10-09' });
});

test('availability: free, partial, booked, unserviceable', () => {
  const idx = bookedIndex([e('a', '2026-10-02'), e('a', '2026-10-03')]);
  assert.deepEqual(availability({ id: 'x' }, idx.get('x'), win), { status: 'free', freeDays: 14, totalDays: 14 });
  assert.deepEqual(availability({ id: 'a' }, idx.get('a'), win), { status: 'partial', freeDays: 12, totalDays: 14 });
  const full = bookedIndex(Array.from({ length: 7 }, (_, i) => e('b', `2026-10-0${i + 1}`)));
  assert.equal(availability({ id: 'b' }, full.get('b'), planWindow('7', '2026-10-01')).status, 'booked');
  assert.equal(availability({ id: 'x', serviceable: 0 }, undefined, win).status, 'unserviceable');
  assert.equal(availText({ status: 'partial', freeDays: 12, totalDays: 14 }), 'Free 12 of 14 days');
});

test('location: a fresh tag wins', () => {
  const loc = resolveLocation({ id: 'a', location: 'WA' }, {
    ping: { lat: -20.7, lng: 116.8, seen_at: '2026-10-01T00:00:00Z', place: 'Karratha, WA' },
    staleDays: 3, booked: bookedIndex([e('a', '2026-10-01')]).get('a'), jobsById: jobs, windowStart: '2026-10-01', nowMs: NOW,
  });
  assert.equal(loc.source, 'tag');
  assert.equal(loc.label, '📍 Karratha, WA · 2 h ago (tag)');
  assert.deepEqual([loc.lat, loc.lng, loc.approx], [-20.7, 116.8, false]);
});

test('location: a stale tag falls through to the booking', () => {
  const loc = resolveLocation({ id: 'a', location: 'WA' }, {
    ping: { lat: 1, lng: 1, seen_at: '2026-09-20T00:00:00Z' },
    staleDays: 3, booked: bookedIndex([e('a', '2026-10-01')]).get('a'), jobsById: jobs, windowStart: '2026-10-01', nowMs: NOW,
  });
  assert.equal(loc.source, 'booked');
  assert.equal(loc.label, '📍 On job HUN-24 · Muswellbrook NSW (booked)');
  assert.deepEqual([loc.lat, loc.lng, loc.jobId], [-32.26, 150.89, 'j1']);
});

test('location: last job within 14 days, else home base, else unknown', () => {
  const last = resolveLocation({ id: 'a', location: 'WA' }, {
    booked: bookedIndex([e('a', '2026-09-25'), e('a', '2026-09-26')]).get('a'), jobsById: jobs, windowStart: '2026-10-01', nowMs: NOW, staleDays: 3,
  });
  assert.equal(last.source, 'last_job');
  assert.equal(last.label, '📍 Last on HUN-24, ended 5 days ago');
  const old = resolveLocation({ id: 'a', location: 'WA' }, {
    booked: bookedIndex([e('a', '2026-09-01')]).get('a'), jobsById: jobs, windowStart: '2026-10-01', nowMs: NOW, staleDays: 3,
  });
  assert.equal(old.source, 'home');
  assert.equal(old.label, '📍 WA base (home)');
  assert.deepEqual([old.lat, old.lng, old.approx], [BASE_CITIES.WA.lat, BASE_CITIES.WA.lng, true]);
  const none = resolveLocation({ id: 'a', location: 'Processing' }, { windowStart: '2026-10-01', nowMs: NOW, staleDays: 3, jobsById: jobs });
  assert.equal(none.source, 'home');
  assert.equal(none.lat, null);
  assert.equal(resolveLocation({ id: 'a' }, { windowStart: '2026-10-01', nowMs: NOW, staleDays: 3, jobsById: jobs }).source, 'unknown');
});

test('a booked job without a site position has no point', () => {
  const j = new Map([['j1', { id: 'j1', code: 'HUN-24', site_address: '', state: 'NSW' }]]);
  const loc = resolveLocation({ id: 'a' }, { booked: bookedIndex([e('a', '2026-10-01')]).get('a'), jobsById: j, windowStart: '2026-10-01', nowMs: NOW, staleDays: 3 });
  assert.equal(loc.label, '📍 On job HUN-24 · NSW (booked)');
  assert.equal(loc.lat, null);
});

test('sortRows and summary', () => {
  const rows = [
    { item: { name: 'B' }, avail: { status: 'booked' } },
    { item: { name: 'Z' }, avail: { status: 'free' } },
    { item: { name: 'A' }, avail: { status: 'free' } },
    { item: { name: 'C' }, avail: { status: 'partial' } },
    { item: { name: 'D' }, avail: { status: 'unserviceable' } },
  ];
  assert.deepEqual(sortRows(rows).map((r) => r.item.name), ['A', 'Z', 'C', 'B', 'D']);
  assert.deepEqual(summary(rows), { free: 2, partial: 1, booked: 1, unserviceable: 1 });
});
```

- [ ] **Step 2:** `node --test client-v2/test/equipmentPlan.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement** `client-v2/src/lib/equipmentPlan.js`:

```js
// Equipment planning: what is free in a window, and where each item is.
// Pure functions over data the V2 app already loads. See
// docs/superpowers/specs/2026-09-28-equipment-planning-view-design.md.
import { addDays, diffDays, rangeOf } from './dates.js';
import { isWork } from './model.js';

export const LAST_JOB_DAYS = 14;

export const BASE_CITIES = {
  WA: { city: 'Perth', lat: -31.95, lng: 115.86 },
  NSW: { city: 'Sydney', lat: -33.87, lng: 151.21 },
  QLD: { city: 'Brisbane', lat: -27.47, lng: 153.03 },
  VIC: { city: 'Melbourne', lat: -37.81, lng: 144.96 },
  SA: { city: 'Adelaide', lat: -34.93, lng: 138.6 },
  TAS: { city: 'Hobart', lat: -42.88, lng: 147.33 },
  NT: { city: 'Darwin', lat: -12.46, lng: 130.84 },
  ACT: { city: 'Canberra', lat: -35.28, lng: 149.13 },
};

export const AVAIL_TONE = { free: 'ok', partial: 'warn', booked: 'danger', unserviceable: 'mute' };
const AVAIL_ORDER = { free: 0, partial: 1, booked: 2, unserviceable: 3 };

export function bookedIndex(schedule) {
  const idx = new Map();
  for (const en of schedule || []) {
    if (!en.job_id || !isWork(en)) continue;
    if (!idx.has(en.team_member_id)) idx.set(en.team_member_id, new Map());
    idx.get(en.team_member_id).set(en.date, en);
  }
  return idx;
}

export function planWindow(preset, today, custom) {
  if (preset === 'custom' && custom?.from && custom?.to) {
    return custom.from <= custom.to ? { from: custom.from, to: custom.to } : { from: custom.to, to: custom.from };
  }
  const n = preset === '7' ? 7 : 14;
  return { from: today, to: addDays(today, n - 1) };
}

export function availability(item, booked, win) {
  const days = rangeOf(win.from, win.to);
  const freeDays = days.filter((d) => !booked?.has(d)).length;
  const totalDays = days.length;
  if (item.serviceable === 0) return { status: 'unserviceable', freeDays, totalDays };
  if (freeDays === totalDays) return { status: 'free', freeDays, totalDays };
  if (freeDays === 0) return { status: 'booked', freeDays, totalDays };
  return { status: 'partial', freeDays, totalDays };
}

export function availText(a) {
  switch (a.status) {
    case 'free': return 'Free';
    case 'partial': return `Free ${a.freeDays} of ${a.totalDays} days`;
    case 'booked': return 'Booked';
    default: return 'Unserviceable';
  }
}

function agoText(iso, nowMs) {
  const mins = Math.round((nowMs - Date.parse(iso)) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 90) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

function siteOf(job) {
  if (!job) return { where: '', lat: null, lng: null };
  const where = (job.site_address || '').split(',')[0].trim() || job.state || '';
  const has = Number.isFinite(job.site_lat) && Number.isFinite(job.site_lng);
  return { where, lat: has ? job.site_lat : null, lng: has ? job.site_lng : null };
}

export function resolveLocation(item, { ping, staleDays = 3, booked, jobsById, windowStart, nowMs = Date.now() }) {
  const none = { lat: null, lng: null, approx: false, jobId: null };
  if (ping?.seen_at && Number.isFinite(ping.lat) && nowMs - Date.parse(ping.seen_at) <= staleDays * 86400000) {
    const place = ping.place || `${ping.lat.toFixed(2)}, ${ping.lng.toFixed(2)}`;
    return { ...none, source: 'tag', label: `📍 ${place} · ${agoText(ping.seen_at, nowMs)} (tag)`, lat: ping.lat, lng: ping.lng };
  }
  const on = booked?.get(windowStart);
  if (on) {
    const job = jobsById?.get(on.job_id);
    const s = siteOf(job);
    const code = job?.code || on.job_code || 'job';
    return { ...none, source: 'booked', label: `📍 On job ${code}${s.where ? ` · ${s.where}` : ''} (booked)`, lat: s.lat, lng: s.lng, jobId: on.job_id };
  }
  const before = [...(booked?.keys() || [])].filter((d) => d < windowStart).sort().pop();
  if (before && diffDays(before, windowStart) <= LAST_JOB_DAYS) {
    const en = booked.get(before);
    const job = jobsById?.get(en.job_id);
    const s = siteOf(job);
    const ago = diffDays(before, windowStart);
    const code = job?.code || en.job_code || 'job';
    return { ...none, source: 'last_job', label: `📍 Last on ${code}, ended ${ago} day${ago === 1 ? '' : 's'} ago`, lat: s.lat, lng: s.lng, jobId: en.job_id };
  }
  if (item.location) {
    const base = BASE_CITIES[item.location];
    return { ...none, source: 'home', label: `📍 ${item.location} base (home)`, lat: base?.lat ?? null, lng: base?.lng ?? null, approx: !!base };
  }
  return { ...none, source: 'unknown', label: '📍 Unknown' };
}

export function sortRows(rows) {
  return [...rows].sort((a, b) => (AVAIL_ORDER[a.avail.status] - AVAIL_ORDER[b.avail.status])
    || (a.item.name || '').localeCompare(b.item.name || ''));
}

export function summary(rows) {
  const out = { free: 0, partial: 0, booked: 0, unserviceable: 0 };
  for (const r of rows) out[r.avail.status] += 1;
  return out;
}
```

`ended N days ago` = `diffDays(lastBookedDay, windowStart)` (last day 26 Sep, window 1 Oct → 5).

- [ ] **Step 4:** Tests → PASS. `npm test` → all pass. Commit `feat(v2): equipment planning logic — availability and best-known location`.

---

### Task 2: Server — job site positions and stale days

**Interfaces — Produces:** `geocodeAddress(address, {fetchImpl, timeoutMs}) -> Promise<{lat,lng}|null>`, `setGeocoder(fn|null)`, `refreshSitePosition(db, jobId) -> Promise<void>`; jobs rows gain `site_lat`, `site_lng`, `site_geocoded_address`; `GET /api/equipment/tracker/stale-days` (requireAuth) → `{stale_days}`.

- [ ] **Step 1: Columns** — in `server/src/db.js`, after the `addJobColumn('site_address', …)` line:

```js
  addJobColumn('site_lat', `site_lat REAL`);                          // geocoded from site_address
  addJobColumn('site_lng', `site_lng REAL`);
  addJobColumn('site_geocoded_address', `site_geocoded_address TEXT`); // the address those belong to
```

- [ ] **Step 2: Failing tests** — `server/test/jobSiteGeocode.test.js`:

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
import jobRoutes from '../src/routes/jobs.js';
import equipmentRoutes from '../src/routes/equipment.js';
import { setGeocoder, geocodeAddress } from '../src/services/geocodeSite.js';

let db, server, base, dbPath, cookie;
const settle = () => new Promise((r) => setTimeout(r, 30));

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-')), 'test.db');
  process.env.DATABASE_PATH = dbPath;
  db = initDb();
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/jobs', requireAuth, jobRoutes);
  app.use('/api/equipment', equipmentRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  setGeocoder(null);
  server?.close();
  db?.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM jobs');
  db.exec("DELETE FROM team_members WHERE id LIKE 'm%'");
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m1','Alex',1,1)").run();
  cookie = `auth_token=${signToken('m1', true)}`;
});

const call = (p, method = 'GET', body) => fetch(`${base}${p}`, {
  method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined,
});
const row = (id) => db.prepare('SELECT site_lat, site_lng, site_geocoded_address FROM jobs WHERE id = ?').get(id);

test('saving a site address stores its position after the response', async () => {
  const seen = [];
  setGeocoder(async (a) => { seen.push(a); return { lat: -32.26, lng: 150.89 }; });
  const job = await (await call('/jobs', 'POST', { code: 'G1', name: 'Geo', site_address: 'Muswellbrook NSW' })).json();
  await settle();
  assert.deepEqual(row(job.id), { site_lat: -32.26, site_lng: 150.89, site_geocoded_address: 'Muswellbrook NSW' });
  await call(`/jobs/${job.id}`, 'PUT', { site_address: 'Muswellbrook NSW' });
  await settle();
  assert.equal(seen.length, 1, 'unchanged address is not looked up again');
});

test('a failed lookup leaves no position; an emptied address clears it', async () => {
  setGeocoder(async () => null);
  const job = await (await call('/jobs', 'POST', { code: 'G2', name: 'Geo', site_address: 'Nowhere' })).json();
  await settle();
  assert.deepEqual(row(job.id), { site_lat: null, site_lng: null, site_geocoded_address: null });
  setGeocoder(async () => ({ lat: 1, lng: 2 }));
  await call(`/jobs/${job.id}`, 'PUT', { site_address: 'Somewhere' });
  await settle();
  assert.equal(row(job.id).site_lat, 1);
  await call(`/jobs/${job.id}`, 'PUT', { site_address: '' });
  await settle();
  assert.deepEqual(row(job.id), { site_lat: null, site_lng: null, site_geocoded_address: null });
});

test('a geocoder that throws never breaks the save', async () => {
  setGeocoder(async () => { throw new Error('down'); });
  const res = await call('/jobs', 'POST', { code: 'G3', name: 'Geo', site_address: 'X' });
  assert.equal(res.status, 201);
  await settle();
});

test('geocodeAddress parses Photon and returns null on errors', async () => {
  const ok = async () => ({ ok: true, json: async () => ({ features: [{ geometry: { coordinates: [150.89, -32.26] } }] }) });
  assert.deepEqual(await geocodeAddress('x', { fetchImpl: ok }), { lat: -32.26, lng: 150.89 });
  assert.equal(await geocodeAddress('x', { fetchImpl: async () => ({ ok: true, json: async () => ({ features: [] }) }) }), null);
  assert.equal(await geocodeAddress('x', { fetchImpl: async () => { throw new Error('net'); } }), null);
  assert.equal(await geocodeAddress('', { fetchImpl: ok }), null);
});

test('stale days are readable by any signed-in user', async () => {
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m2','Sam',0,1)").run();
  const res = await fetch(`${base}/equipment/tracker/stale-days`, { headers: { cookie: `auth_token=${signToken('m2', false)}` } });
  assert.deepEqual(await res.json(), { stale_days: 3 });
});
```

- [ ] **Step 3:** Run → FAIL.

- [ ] **Step 4: Service** — `server/src/services/geocodeSite.js`:

```js
// Job site → map position, looked up once per address and never on the
// request path: saving a job must not wait on a third-party service.
const PHOTON = 'https://photon.komoot.io/api/';

export async function geocodeAddress(address, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const q = String(address || '').trim();
  if (!q) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `${PHOTON}?q=${encodeURIComponent(q)}&limit=1&lat=-25&lon=134`;
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'User-Agent': 'taskz.id ops-schedule' } });
    if (!res.ok) return null;
    const body = await res.json();
    const c = body?.features?.[0]?.geometry?.coordinates;
    return Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? { lat: c[1], lng: c[0] } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let geocoder = (a) => geocodeAddress(a);
export function setGeocoder(fn) {
  geocoder = fn || ((a) => geocodeAddress(a));
}

export function refreshSitePosition(db, jobId) {
  const job = db.prepare('SELECT site_address, site_geocoded_address FROM jobs WHERE id = ?').get(jobId);
  if (!job) return Promise.resolve();
  const addr = String(job.site_address || '').trim();
  if (!addr) {
    db.prepare('UPDATE jobs SET site_lat = NULL, site_lng = NULL, site_geocoded_address = NULL WHERE id = ?').run(jobId);
    return Promise.resolve();
  }
  if (addr === job.site_geocoded_address) return Promise.resolve();
  return Promise.resolve()
    .then(() => geocoder(addr))
    .then((pos) => {
      if (pos) {
        db.prepare('UPDATE jobs SET site_lat = ?, site_lng = ?, site_geocoded_address = ? WHERE id = ?')
          .run(pos.lat, pos.lng, addr, jobId);
      } else {
        db.prepare('UPDATE jobs SET site_lat = NULL, site_lng = NULL, site_geocoded_address = NULL WHERE id = ?').run(jobId);
      }
    })
    .catch((err) => console.error('site geocode failed', jobId, err?.message));
}
```

- [ ] **Step 5: Hooks** — in `server/src/routes/jobs.js` import `{ refreshSitePosition }` from `'../services/geocodeSite.js'`; add `refreshSitePosition(req.db, id);` right after `res.status(201).json(job);` in `POST /`, and `refreshSitePosition(req.db, req.params.id);` right after the `res.json({ ...job, … })` in `PUT /:id`.

In `server/src/routes/equipment.js` import `getStaleDays` from trackerItems and add:

```js
// Readable by everyone signed in: the equipment view uses it to decide when a
// tag position is too old to trust as an item's location.
router.get('/tracker/stale-days', requireAuth, (req, res) => {
  res.json({ stale_days: getStaleDays(req.db) });
});
```

- [ ] **Step 6: Backfill** — `scripts/geocode-job-sites.mjs`:

```js
// One-off: give existing jobs a map position from their site address.
// Run on the server: node scripts/geocode-job-sites.mjs   (1 lookup/second)
import { initDb } from '../server/src/db.js';
import { geocodeAddress } from '../server/src/services/geocodeSite.js';

const db = initDb();
const jobs = db.prepare(`
  SELECT id, code, site_address FROM jobs
  WHERE TRIM(COALESCE(site_address, '')) != '' AND site_lat IS NULL
`).all();
let found = 0;
for (const j of jobs) {
  const pos = await geocodeAddress(j.site_address);
  if (pos) {
    db.prepare('UPDATE jobs SET site_lat = ?, site_lng = ?, site_geocoded_address = ? WHERE id = ?')
      .run(pos.lat, pos.lng, j.site_address.trim(), j.id);
    found += 1;
  }
  console.log(`${j.code}: ${pos ? `${pos.lat.toFixed(3)}, ${pos.lng.toFixed(3)}` : 'not found'}`);
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`${found}/${jobs.length} jobs located`);
```

- [ ] **Step 7:** Tests → PASS; `npm test`. Commit `feat(jobs): geocode job sites for the equipment map`.

---

### Task 3: Planning bar, row labels, window shading

**Files:** `Timeline.jsx`, `PlanningBar.jsx` (new), `EquipmentView.jsx`, `App.jsx`, `api.js`, `styles.css`.

- [ ] **Step 1: Timeline** — add optional props `highlight` (`{from, to}`) and support `row.minHeight`:
  - In the body wash block, after the today wash: 

```jsx
            {highlight && (() => {
              const a = days.indexOf(highlight.from);
              const b = days.indexOf(highlight.to);
              if (a < 0 && b < 0) return null;
              const s = a < 0 ? 0 : a;
              const e = b < 0 ? days.length - 1 : b;
              return <div className="tl-wash-window" style={{ left: s * colW, width: (e - s + 1) * colW }} />;
            })()}
```
  - Row height: `const h = Math.max(rowHeight(row.lanes || 1), row.minHeight || 0);`
  - Add `data-row-id={row.id}` to the `.tl-row` div.

- [ ] **Step 2: API** — in `client-v2/src/api.js`:

```js
export const getStaleDays = () => api('/equipment/tracker/stale-days');
export const getEquipmentLocationHistory = (id, days = 7) => api(`/equipment/locations/${id}/history?days=${days}`);
```

- [ ] **Step 3: PlanningBar** — `client-v2/src/components/PlanningBar.jsx`:

```jsx
import React from 'react';
import { fmtShort } from '../lib/dates.js';

// "What is free, and where" — the window everything on the Equipment tab is
// judged against.
export default function PlanningBar({ plan, onPlan, win, counts }) {
  const set = (patch) => onPlan({ ...plan, ...patch });
  return (
    <div className="plan-bar">
      <strong className="plan-title">Plan</strong>
      <div className="chips" role="group" aria-label="Planning window">
        {[['7', '7 days'], ['14', '14 days'], ['custom', 'Custom']].map(([v, l]) => (
          <button key={v} type="button" className={`chip${plan.preset === v ? ' is-active' : ''}`}
            onClick={() => set({ preset: v, from: plan.from || win.from, to: plan.to || win.to })}>{l}</button>
        ))}
      </div>
      {plan.preset === 'custom' ? (
        <span className="plan-dates">
          <input type="date" value={plan.from || win.from} onChange={(e) => set({ from: e.target.value })} aria-label="From" />
          –
          <input type="date" value={plan.to || win.to} onChange={(e) => set({ to: e.target.value })} aria-label="To" />
        </span>
      ) : (
        <span className="plan-dates">{fmtShort(win.from)} – {fmtShort(win.to)}</span>
      )}
      <label className="plan-free">
        <input type="checkbox" checked={!!plan.freeOnly} onChange={(e) => set({ freeOnly: e.target.checked })} /> Free only
      </label>
      <span className="plan-summary">
        <span className="tag tag-ok">{counts.free} free</span>
        <span className="tag tag-warn">{counts.partial} part free</span>
        <span className="tag tag-danger">{counts.booked} booked</span>
        {counts.unserviceable > 0 && <span className="tag tag-mute">{counts.unserviceable} U/S</span>}
      </span>
    </div>
  );
}
```

- [ ] **Step 4: EquipmentView** — changes:
  - Props: add `jobs`, `onEnsureRange`.
  - State: `plan` from `localStorage['eq.plan']` (default `{preset:'14', freeOnly:false}`), saved on change (try/catch); `locations` + `staleDays` loaded once with `getEquipmentLocations()` / `getStaleDays()` (failures → `[]` / `3`); `selectedId`.
  - `const win = planWindow(plan.preset, today(), { from: plan.from, to: plan.to })`; `useEffect(() => onEnsureRange?.(addDays(win.from, -LAST_JOB_DAYS), win.to), [win.from, win.to])`.
  - `booked = useMemo(() => bookedIndex(schedule), [schedule])`, `jobsById = new Map(jobs.map(j => [j.id, j]))`, `pingById = new Map(locations.filter(l => l.seen_at).map(l => [l.id, l]))`.
  - In the rows map add `avail = availability(item, booked.get(item.id), win)` and `loc = resolveLocation(item, { ping: pingById.get(item.id), staleDays, booked: booked.get(item.id), jobsById, windowStart: win.from })`, `minHeight: 56`; drop rows with `plan.freeOnly && avail.status !== 'free'`.
  - Group rows sorted with `sortRows` (replacing the name sort). `counts = summary(all rows before the free-only filter)`.
  - `renderLabel`: keep the name button (opens editor) and the U/S/clash tags; replace the right-hand `Nd/free` with `<span className={`tag tag-${AVAIL_TONE[row.avail.status]}`}>{availText(row.avail)}</span>`; add under the sub line a button `className="rl-loc"` showing `row.loc.label` that calls `setSelectedId(row.id)` (title "Show on map"); add `is-selected` class on the label when `row.id === selectedId`.
  - Render `<PlanningBar plan={plan} onPlan={setPlan} win={win} counts={counts} />` above the existing toolbar and pass `highlight={win}` to `Timeline`.
- [ ] **Step 5: App** — pass `jobs={jobs}` and `onEnsureRange={onEnsureRange}` to `EquipmentView`.
- [ ] **Step 6: Styles** — append to `client-v2/src/styles.css`:

```css
/* Equipment planning */
.plan-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 12px; border-top: 1px solid var(--line-soft); }
.plan-title { font-size: 12px; }
.plan-dates { font-size: 12px; color: var(--text-dim); display: inline-flex; gap: 4px; align-items: center; }
.plan-free { font-size: 12px; display: inline-flex; gap: 4px; align-items: center; }
.plan-summary { display: inline-flex; gap: 4px; margin-left: auto; }
.tl-wash-window { position: absolute; top: 0; bottom: 0; background: rgba(99, 132, 255, 0.07); border-left: 1px dashed rgba(99, 132, 255, 0.5); border-right: 1px dashed rgba(99, 132, 255, 0.5); }
.rl-loc { display: block; max-width: 100%; text-align: left; background: none; border: 0; padding: 0; font-size: 11px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.rl-loc:hover { color: var(--accent); }
.tl-label.is-selected, .is-selected-row { box-shadow: inset 3px 0 0 var(--accent); }
```

- [ ] **Step 7:** `npm test && (cd client-v2 && npx vite build)`; check in the browser (planning bar presets, custom, Free only, labels, shading). Commit `feat(v2): planning window, availability chips and locations on the equipment timeline`.

---

### Task 4: Map pane with shared selection

**Files:** `client-v2/package.json` (+ lockfile), `client-v2/src/components/EquipmentMapPanel.jsx` (new), `EquipmentView.jsx`, `styles.css`.

- [ ] **Step 1:** `cd client-v2 && npm install leaflet@^1.9.4`.

- [ ] **Step 2: Component** — `client-v2/src/components/EquipmentMapPanel.jsx`:

```jsx
import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { getEquipmentLocationHistory } from '../api.js';

const TONE_COLOR = { ok: '#2b8a3e', warn: '#e67700', danger: '#c92a2a', mute: '#868e96' };
const keyOf = (p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;

// Where the equipment is, for the rows the timeline is showing. Selection is
// owned by the parent so the row list and the map always agree.
export default function EquipmentMapPanel({ points, sites, notOnMap, selectedId, onSelect }) {
  const el = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const trail = useRef(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    const m = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([-25.5, 134], 4);
    const tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(m);
    let errors = 0;
    tiles.on('tileerror', () => { errors += 1; if (errors > 8) setBroken(true); });
    layer.current = L.layerGroup().addTo(m);
    trail.current = L.layerGroup().addTo(m);
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => { ro.disconnect(); m.remove(); };
  }, []);

  useEffect(() => {
    const g = layer.current;
    if (!g) return;
    g.clearLayers();
    for (const s of sites) {
      L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: 'eqm-site', html: `<span title="${s.code}">🏗<b>${s.code}</b></span>`, iconSize: null }),
        interactive: false,
      }).addTo(g);
    }
    const groups = new Map();
    for (const p of points) {
      const k = keyOf(p);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    for (const list of groups.values()) {
      const p = list[0];
      const sel = list.some((x) => x.id === selectedId);
      if (list.length === 1) {
        L.circleMarker([p.lat, p.lng], {
          radius: sel ? 10 : 7, weight: sel ? 4 : 2, color: sel ? '#3b5bdb' : '#fff',
          fillColor: TONE_COLOR[p.tone] || TONE_COLOR.mute, fillOpacity: p.approx ? 0.35 : 0.95,
        }).on('click', () => onSelect(p.id)).bindTooltip(p.name).addTo(g);
      } else {
        const html = `<span class="eqm-count${sel ? ' is-sel' : ''}">${list.length}</span>`;
        const m = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: 'eqm-group', html, iconSize: [26, 26] }) });
        const box = document.createElement('div');
        box.className = 'eqm-popup';
        for (const x of list) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = x.name;
          b.onclick = () => onSelect(x.id);
          box.appendChild(b);
        }
        m.bindPopup(box).addTo(g);
      }
    }
  }, [points, sites, selectedId, onSelect]);

  // Pan to the selection and draw its 7-day trail when it has a tag.
  useEffect(() => {
    const m = map.current;
    trail.current?.clearLayers();
    const p = points.find((x) => x.id === selectedId);
    if (!m || !p) return;
    m.panTo([p.lat, p.lng]);
    if (p.source !== 'tag') return;
    let alive = true;
    getEquipmentLocationHistory(p.id, 7).then((rows) => {
      if (!alive || !rows?.length) return;
      L.polyline(rows.map((r) => [r.lat, r.lng]), { color: '#3b5bdb', weight: 2, opacity: 0.7 }).addTo(trail.current);
    }).catch(() => {});
    return () => { alive = false; };
  }, [selectedId, points]);

  const fit = () => {
    const all = [...points, ...sites].map((p) => [p.lat, p.lng]);
    if (all.length) map.current.fitBounds(all, { padding: [30, 30], maxZoom: 11 });
  };

  return (
    <div className="eqm">
      <div className="eqm-map" ref={el}>
        {broken && <div className="eqm-broken">Map unavailable — the timeline still works.</div>}
      </div>
      <div className="eqm-foot">
        <button type="button" className="btn" onClick={fit}>Fit</button>
        {notOnMap.length > 0 && (
          <details className="eqm-nomap">
            <summary>Not on map ({notOnMap.length})</summary>
            {notOnMap.map((r) => (
              <button type="button" key={r.id} className="rl-loc" onClick={() => onSelect(r.id)}>{r.name} — {r.label}</button>
            ))}
          </details>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire into EquipmentView** —
  - From the visible rows build `points` (`{id, name, lat, lng, approx, tone: AVAIL_TONE[avail.status], source}` where `loc.lat != null`), `notOnMap` (`{id, name, label}` otherwise), and `sites` = unique jobs with a position that appear in `booked` within the window (`{code, lat, lng}`).
  - `onSelect = useCallback((id) => { setSelectedId(id); document.querySelector(`[data-row-id="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [])`.
  - Layout: wrap `Timeline` and the map in:

```jsx
      <div className={`eq-split${mapOpen ? '' : ' is-collapsed'}`} style={{ '--mapw': `${mapWidth}px` }} data-pane={pane}>
        <div className="eq-left"><Timeline … /></div>
        {mapOpen && <div className="eq-divider" onPointerDown={startDrag} role="separator" aria-label="Resize map" />}
        {mapOpen && <div className="eq-right"><EquipmentMapPanel points={points} sites={sites} notOnMap={notOnMap} selectedId={selectedId} onSelect={onSelect} /></div>}
      </div>
```
  - `mapWidth` (default `Math.round(window.innerWidth * 0.38)`, clamped 280–900) and `mapOpen` (default true) from/to `localStorage` (`eq.mapWidth`, `eq.mapOpen`, try/catch). `startDrag` tracks pointer moves on `window` and sets `mapWidth = clamp(window.innerWidth - e.clientX)`.
  - Add to the toolbar: a `Map` toggle button (`mapOpen`), and — shown only under 768px via CSS — a `Timeline | Map` pair setting `pane`.
- [ ] **Step 4: Styles** — append:

```css
.eq-split { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 6px var(--mapw, 420px); }
.eq-split.is-collapsed { grid-template-columns: minmax(0, 1fr); }
.eq-left { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.eq-divider { cursor: col-resize; background: var(--line-soft); }
.eq-divider:hover { background: var(--accent); }
.eq-right { min-height: 0; display: flex; }
.eqm { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.eqm-map { flex: 1; min-height: 240px; position: relative; }
.eqm-broken { position: absolute; inset: 0; display: grid; place-items: center; z-index: 500; background: var(--bg); color: var(--text-dim); font-size: 12px; }
.eqm-foot { display: flex; gap: 8px; align-items: flex-start; padding: 6px; border-top: 1px solid var(--line-soft); }
.eqm-nomap { font-size: 12px; }
.eqm-site span { font-size: 16px; white-space: nowrap; }
.eqm-site b { font-size: 10px; margin-left: 2px; background: #fff; color: #222; padding: 0 3px; border-radius: 3px; }
.eqm-count { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: #3b5bdb; color: #fff; font-weight: 700; font-size: 12px; border: 2px solid #fff; }
.eqm-count.is-sel { box-shadow: 0 0 0 3px #3b5bdb88; }
.eqm-popup { display: grid; gap: 4px; }
.eqm-popup button { text-align: left; border: 0; background: none; color: #3b5bdb; cursor: pointer; }
.eq-pane-toggle { display: none; }
@media (max-width: 767px) {
  .eq-split { grid-template-columns: minmax(0, 1fr); }
  .eq-divider { display: none; }
  .eq-split[data-pane="timeline"] .eq-right { display: none; }
  .eq-split[data-pane="map"] .eq-left { display: none; }
  .eq-pane-toggle { display: inline-flex; }
}
```

- [ ] **Step 5:** Build, then browser: row location click → pin highlighted and panned; pin click → row highlighted and scrolled; group popup; Fit; collapse and divider persist after reload; 375px toggle; no console errors. Commit `feat(v2): equipment map beside the timeline with shared selection`.

---

### Task 5: Job card note, ship

- [ ] **Step 1:** In `client-v2/src/components/JobCard.jsx`, under the Site address field:

```jsx
          {job.site_address && job.site_lat == null && (
            <div className="rl-sub" style={{ gridColumn: '1 / -1' }}>Site not found on map — check the address.</div>
          )}
```

(`job` is the loaded job; after saving a new address the note may show until the next load, which is acceptable.)

- [ ] **Step 2:** `npm test`, build, commit `feat(v2): flag job sites the map cannot place`.
- [ ] **Step 3:** Merge to main, push (deploys), verify live bundle hash, then run the backfill on the server: `ssh tagz-host 'cd ~/domains/taskz.id/nodejs && export PATH=/opt/alt/alt-nodejs20/root/bin:$PATH && DATABASE_PATH=~/data/ops-schedule.db node scripts/geocode-job-sites.mjs'` (read-only apart from the three new columns; confirm with the user before running against production).
