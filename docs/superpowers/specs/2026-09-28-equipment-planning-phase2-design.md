# Equipment Planning, Phase 2 — Design (moves, usage, near a place)

> **Date:** 28 Sep 2026 · **Author:** Claude (from Grant's brief)
> **Builds on:** `2026-09-28-equipment-planning-view-design.md` (planning window, best-known location, map beside the timeline — live).
> **Brief:** "Phase 2 of the equipment view": where kit has to go next, how much it is used, and what is free near a given place.

---

## 1. Decisions

| # | Decision | Chosen |
|---|---|---|
| D1 | Flags | **Movement flags from bookings now** (needs moving, tight turnaround, base→site); **tag checks** (not at site, not returned) switch on automatically when a tag has a position within the stale threshold |
| D2 | Where flags show | A **Moves** strip (transport list for the window) + 🚚 / ⚠ row chips + a dashed arrow on the map for the selected item |
| D3 | Usage | Row "Used N%" (last 30 days), group header average, **Sitting idle** list |
| D4 | Near a place | **Job or typed town**, radius 100 / 250 / 500 / 1000 km (default 500); filters + sorts rows nearest-first, map zooms with a circle |
| D5 | Where computed | In the browser (`lib/equipmentPlan.js`), like phase 1; the server only adds a cached town lookup |

## 2. Rules (`client-v2/src/lib/equipmentPlan.js`)

Constants: `ROAD_FACTOR = 1.3`, `KM_PER_DAY = 800`, `MOVE_LOOKAHEAD_DAYS = 14`, `SAME_SITE_KM = 1`, `BASE_MOVE_KM = 250`, `TAG_SITE_KM = 50`, `NOT_RETURNED_DAYS = 3`, `USAGE_DAYS = 30`.

- `haversineKm(a, b)` — great-circle km between `{lat,lng}` points.
- `jobRuns(booked: Map<date, entry>)` → consecutive date runs per job, sorted: `[{jobId, from, to}]` (a run breaks on a change of job or a gap of more than one day).
- `movesFor(item, { runs, jobsById, win, today })` → `Move[]`:
  - For consecutive runs A→B with A.jobId ≠ B.jobId and B.from in `[win.from, win.to + MOVE_LOOKAHEAD_DAYS]`: sites differ when both have positions and `haversineKm > SAME_SITE_KM`, or when either lacks a position and the jobs' states differ. Same site → no move.
  - Base move: for the first run R with `R.from` in that range and no earlier run within 14 days, if `BASE_CITIES[item.location]` exists and the site is > `BASE_MOVE_KM` from it → move from `{kind:'base'}`.
  - `Move = { itemId, from: {label, lat, lng, jobId?}, to: {label, lat, lng, jobId}, leaveAfter, dueBy, gapDays, km|null, needDays|null, tight }`
  - `km = round10(haversineKm × ROAD_FACTOR)` when both points known, else null; `gapDays = diffDays(leaveAfter, dueBy) - 1` (days strictly between); `needDays = max(1, ceil(km / KM_PER_DAY))`; `tight = km != null && gapDays < needDays`.
- `tagChecks(item, { ping, staleDays, runs, jobsById, today, nowMs })` → `Check[]` (only with a fresh ping):
  - `not_at_site`: a run covers `today`, its job has a position, ping > `TAG_SITE_KM` from it.
  - `not_returned`: no run covers `today`, the latest run ended ≥ `NOT_RETURNED_DAYS` days before today, ping ≤ `TAG_SITE_KM` from that run's site.
- `usagePct(booked, today)` → `round(100 × bookedDaysIn[today-30, today-1] / 30)`.
- `isIdle(item, booked, today)` → no booked days in `[today-30, today+29]`; always false for `serviceable === 0` or `active === 0`.
- `lastUsed(booked, today)` → latest booked date before today, or null.
- `nearFilter(rows, place, radiusKm)` → rows whose `loc` has a point within radius, each with `distKm`, sorted ascending.

## 3. Server — town lookup

`GET /api/geocode?q=…` (requireAuth) → `{ found: true, lat, lng, label }` or `{ found: false }`.
- Uses `geocodeAddress` (Photon, AU-biased, 5 s) extended to also return a label (`name, state`).
- In-memory cache keyed by lower-cased trimmed query, 24 h TTL, max 500 entries (oldest evicted).
- Rate limit 30 lookups/min per user → 429 `{ error: 'Too many lookups — try again shortly' }`.
- Empty or > 120-char query → 400.

## 4. Screen

- **PlanningBar**: `Near` control after Free only — a combobox: typing filters jobs that have a site position; choosing one uses that site; Enter on free text calls `/api/geocode`. Radius chips 100 / 250 / 500 / 1000 km, ✕ clears. Stored in `plan.near = { label, lat, lng, radius }`. Not-found → inline message, filter not applied.
- **MovesStrip** (new component) under the planning bar: two toggle buttons `🚚 Moves (n) · k tight` and `💤 Sitting idle (m)`; each opens its list (collapsed by default; open state remembered in `localStorage` `eq.strip`).
  - Moves list: tag checks first (⚠, red), then moves by `dueBy`: `Name · From → To · leave after D · due D · ~N km · G days (needs X)`; tight in red; unknown distance says so.
  - Idle list: `Name · 📍 location label · last used D` (or "not used in 30 days").
  - Clicking a line calls `onSelect(itemId)`.
- **Rows**: 🚚 chip (red if any move is tight) / ⚠ chip; `Used N%` in muted text after the availability chip. Group header `meta` shows the group's average `N%`.
- **Map**: for the selected item, its first listed move drawn as a dashed polyline from→to with a label `leave D → due D`; when `plan.near` is set, `L.circle` of the radius at the place and `fitBounds` to it.
- Phone: the strip's lists open full width; nothing else changes.

## 5. Errors

- Town not found / 429 / network → message under the Near box; rows unfiltered.
- Site without position → move shown with "distance unknown", never tight; no arrow drawn.
- No fresh tag positions → no ⚠ checks (today's state).
- A next job beyond the loaded schedule range → no move shown yet (the view already requests `win.to + 14` days to be loaded — extend `onEnsureRange` to cover the lookahead).

## 6. Testing

- `client-v2/test/equipmentPlan.test.js`: haversine sanity (Perth→Sydney ≈ 3,290 km); `jobRuns` splitting; moves: same site (none), different sites, state fallback without positions, lookahead edge, base move over/under 250 km, tight boundary (gap = need → not tight); tag checks both kinds and stale ping → none; usage edges (day 30 in/out); idle excludes inactive/unserviceable; `nearFilter` sort and radius edge.
- `server/test/geocodeLookup.test.js`: found / not found via fake geocoder, cache hit (fake called once), 30/min limit → 429, signed-in only, bad query 400.
- Browser: Near with a job and a town, radius change, Moves and Idle lists, click → selection + arrow, chips, 375 px.

## 7. Out of scope

Real road routing, truck/driver assignment, CSV export, notifications.
