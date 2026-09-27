# Equipment Planning View — Design (V2 Equipment tab)

> **Date:** 28 Sep 2026 · **Author:** Claude (from Grant's brief)
> **Brief:** "Looking a week or two ahead at what equipment is available and where it is located is very useful." The V2 Equipment tab today is a booking Gantt only; locations live on V1's separate Equipment Map.
> **Layout chosen:** option A of three mockups — timeline left, map right, one shared selection (`.superpowers/brainstorm/…/layout.html`).
> **Phase 1 of 2.** Phase 2 (separate spec): should-be-vs-is flags (not at site / due elsewhere / not returned), utilisation %, "near a place" search.

---

## 1. Decisions

| # | Decision | Chosen |
|---|---|---|
| D1 | Source of an item's location | Best available, labelled: tag (≤ stale threshold) → job booked on the window's start day → most recent job ended within 14 days → home base → unknown |
| D2 | Looking ahead | A planning window (7 / 14 days / custom, default 14 from today) drives availability chips, location "as of window start", Free-only filter and timeline shading |
| D3 | Layout | Side by side on desktop (timeline ≈62%, map ≈38%, draggable divider, collapsible); Timeline / Map toggle under 768px |
| D4 | Job sites on the map | Server geocodes `jobs.site_address` once on save into `site_lat`/`site_lng` (Photon, as V1's reverse geocoder) |

## 2. Location rules (`client-v2/src/lib/equipmentPlan.js`)

`resolveLocation(item, { ping, staleDays, bookings, jobsById, windowStart, today }) → { source, label, lat, lng, approx, jobId }`

| Priority | Condition | `source` | Label | Map point |
|---|---|---|---|---|
| 1 | `ping.seen_at` within `staleDays` of `today` | `tag` | `📍 {place or lat,lng} · {ago} (tag)` | ping lat/lng |
| 2 | item has a booked day on `windowStart` | `booked` | `📍 On job {code} · {site or state} (booked)` | job site lat/lng if known, else none |
| 3 | latest booked day before `windowStart` is ≥ `windowStart − 14 days` | `last_job` | `📍 Last on {code}, ended {n} days ago` | job site lat/lng if known |
| 4 | `item.location` (state) set | `home` | `📍 {state} base (home)` | `BASE_CITIES[state]`, `approx: true` |
| 5 | otherwise | `unknown` | `📍 Unknown` | none |

"Booked day" = any schedule entry for the item with a job (work statuses per `isWork`), including kit pad (buffer) days. `place` comes from V1's reverse-geocode logic ported into `client-v2/src/lib/geocode.js` (Photon → BigDataCloud, module cache); until it resolves, show coordinates to 2 dp.

`BASE_CITIES`: `WA` Perth (-31.95, 115.86), `NSW` Sydney (-33.87, 151.21), `QLD` Brisbane (-27.47, 153.03), `VIC` Melbourne (-37.81, 144.96), `SA` Adelaide (-34.93, 138.60), `TAS` Hobart (-42.88, 147.33), `NT` Darwin (-12.46, 130.84), `ACT` Canberra (-35.28, 149.13). `Processing` / `Other` → no point.

## 3. Availability (`equipmentPlan.js`)

`availability(item, bookedDates: Set<string>, window: {from, to}) → { status, freeDays, totalDays }`

- `unserviceable` if `item.serviceable === 0` (regardless of bookings)
- else count window days not in `bookedDates`: all free → `free`; none free → `booked`; otherwise `partial`
- Chip text: Free / Free {freeDays} of {totalDays} days / Booked / Unserviceable; colours ok / warn / danger / mute.
- `summary(rows) → { free, partial, booked, unserviceable }`; `sortRows` orders free, partial, booked, unserviceable, then name.

## 4. Screen (`EquipmentView.jsx` + new components)

- **`PlanningBar.jsx`**: 7 days · 14 days · Custom (from/to date inputs) · Free only · summary line. State persisted in `localStorage` (`eq.plan`), wrapped in try/catch.
- **Row labels** (existing `Timeline` label column): name, location line, chip. Rows sorted per `sortRows` within each group. `Free only` removes non-`free` rows.
- **Timeline**: window shaded (new optional `highlight: {from, to}` prop on `Timeline`), scrolled into view when the window changes.
- **`EquipmentMap.jsx`** (V2, Leaflet): pins coloured by chip; `approx` pins faded; job sites with kit booked in the window as 🏗 markers labelled with job code; pins at the same point grouped into a count bubble (simple same-coordinate grouping, no clustering library); Fit button; "Not on map (n)" list below. Selecting a tagged item loads its 7-day trail via `getEquipmentLocationHistory(id, 7)` (new V2 api call mirroring V1).
- **Shared selection**: `selectedId` lifted into `EquipmentView`; row click → highlight + pan to pin; pin click → highlight + scroll row into view. Single selection.
- **Layout**: CSS grid, divider drag + collapse remembered in `localStorage` (`eq.mapWidth`, `eq.mapOpen`), same pattern as the project job-card panel. Under 768px: Timeline / Map toggle; tapping a pin shows a card with "Open in timeline".
- All existing filters (search, Active/Inactive/All, home base / category grouping) apply to both panes.
- Dependency: add `leaflet` to `client-v2/package.json` (same major as V1, `^1.9.4`); tiles `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png` with OSM attribution.

## 5. Server — job site positions

- `jobs` gains `site_lat REAL`, `site_lng REAL`, `site_geocoded_address TEXT` (the address the position belongs to).
- `server/src/services/geocodeSite.js`: `geocodeAddress(address, { fetchImpl, timeoutMs = 5000 }) → {lat, lng} | null` using Photon `https://photon.komoot.io/api/?q=…&limit=1` biased to Australia (`lat=-25&lon=134`); returns null on any error/timeout/no result.
- On `POST /api/jobs` and `PUT /api/jobs/:id`: if `site_address` is non-empty and differs from `site_geocoded_address`, geocode **after** responding (fire-and-forget, errors logged) and store lat/lng + address; an emptied address clears all three.
- `GET /api/jobs` and job card responses include `site_lat`, `site_lng`.
- One-off backfill script `scripts/geocode-job-sites.mjs`: geocodes jobs with an address and no position, 1 request/second.
- Job card (V2 `JobCard.jsx`) shows "Site not found on map — check the address" when an address exists but no position.

## 6. Errors

- Tiles fail → map pane shows "Map unavailable"; timeline, chips and filters unaffected.
- Address not found / Photon down → no site pin; booked items keep their label without a point; retried on next address save or backfill run.
- Stale tag → ignored as a source (falls through D1), still shown as stale in Settings.

## 7. Testing

- `client-v2/test/equipmentPlan.test.js`: every location priority incl. stale-tag fall-through, 14-day last-job cut-off, window start on a booked pad day, no base city for `Processing`; availability free/partial/booked/unserviceable, partial windows, pads counted; `summary`; `sortRows`.
- `server/test/jobSiteGeocode.test.js`: save stores position via injected fake geocoder; failure leaves null; address change re-geocodes, clearing removes; backfill touches only jobs without a position.
- Browser: 14-day and custom windows, Free only, row→pin and pin→row selection, trail for a tagged item, divider/collapse persistence, 375px toggle.

## 8. Out of scope (phase 2)

Should-be-vs-is flags, utilisation %, idle list, "near a place" availability search, marker clustering beyond same-coordinate grouping.
