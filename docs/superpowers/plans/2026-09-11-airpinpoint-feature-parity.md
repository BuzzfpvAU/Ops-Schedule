# AirPinpoint Feature Parity — Equipment Tracking (taskz.id) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Date:** 11 Sep 2026 · **Author:** Hermes Agent
> **Companion research:** full AirPinpoint platform audit (441 pages, API, SDKs, changelog) archived in `~/airpinpoint-research/`.
> **Goal:** replicate the complete AirPinpoint (airpinpoint.com) feature set inside the taskz.id Equipment module, fitted to the existing Express + better-sqlite3 + React/Leaflet stack.

---

## 1. Background — what AirPinpoint is and how it works

AirTag-based asset-tracking SaaS ($11.99–14.99/tag/mo + their own Find My-certified hardware, 6mo–7yr battery). One-time Mac/iCloud key extraction → server-side Find My network polling → dashboard with map, geofences, auto check-in/out, alerts, history, share links, QR, API/webhooks, AI assistant.

**Their pipeline is already what we built:** the `tracker/` FindMy.py poller (multi-Apple-ID, batch POST with `X-Ingest-Key`, name-matching to `airtag_name`) is the same architecture they run — ours is live and feeding the Equipment Map.

**Their complete feature set (parity target):** live map w/ satellite + trails + staleness · inventory w/ status/battery/photo, bulk edit · circle **and polygon** geofences · auto check-in/out driving a 4-level status model (Checked Out > Delivered > Available > Unknown) · email/SMS alerts + throttling · webhooks (HMAC, retries, delivery log) · location history playback + CSV/JSON export · share links · QR check-in/out + label printing · multi-user + roles · REST API (100 req/min) + SDKs · Zapier/MCP integrations · AI assistant · reports/analytics.

---

## 2. Current state (verified in code, 11 Sep 2026)

| Area | Status |
|---|---|
| Equipment register | ✅ `team_members` w/ `is_equipment=1`, `airtag_name`, `equipment_category` (Drones/Payloads/Batteries/Survey Equip/Accessories/Spare Parts), serial/dimensions/weight/serviceable/sds_url/info_url |
| Location ingest | ✅ `POST /api/equipment/locations` — batch, `softAuth` + `X-Ingest-Key` (`timingSafeEqual`), `{inserted, unmatched, invalid}` partial-failure reporting |
| Location storage | ✅ `equipment_locations` (lat/lng/accuracy/battery/source/seen_at) + `(team_member_id, seen_at DESC)` index; 30d/500pt history endpoint |
| Tracker | ✅ `tracker/` multi-Apple-ID (accounts/<slug>/), launchd every 20 min, battery labels (Full/Medium/Low/Very Low from status bits). TODO: finish Apple sign-in + key export |
| Equipment Map | ✅ Leaflet dark map, category/state grouping + filtering, staleness badges (fresh <24h / stale 1–7d / very-stale >7d), 30d trail on popup, drag-pin / pick-on-map manual updates, reverse-geocoded city/state |
| Notifications | ✅ per-member notifications table + NotificationBell + unread counts; Resend email wired for account flows |
| Auth/roles | ✅ JWT httpOnly cookies, WebAuthn passkeys, admin/member/viewer roles, shared viewer account |
| Missing (this plan) | Geofences · auto check-in/out status engine · equipment alerts (email/bell) · history playback · share links · QR labels + scanning · satellite toggle · bulk edit · public API keys + webhooks · reports/AI |

**Deployment note:** prod (`taskz.id`, Hostinger Passenger Node 20, DB `~/data/ops-schedule.db`) is currently live at `2613010` (mobile view deployed; verified 11 Sep — bundle `index-CrIvQEye.js`). **No cron/scheduler exists in prod** — this drives the key design decision below.

---

## 3. Architecture fit (design decisions for this stack)

1. **Geofence evaluation runs at ingest time, not on a cron.** Every position write (tracker batch or manual UI update) immediately evaluates that asset against its assigned geofences and updates status/events/notifications. No scheduler needed; statuses are "as of last known position", which matches AirPinpoint's own semantics. (Optional phase-3 extra: hourly sweep via VPS crontab for staleness alerts.)
2. **Status model (AirPinpoint's, mapped to AUAV ops):** priority `checked_out` (manual) > `delivered` (inside a delivery geofence) > `available` (inside a check-in geofence) > `unknown` (outside everything). Manual check-out wins until a manual check-in **or** (if the item's auto-check-in toggle is on) re-entry into a check-in geofence.
3. **Schema changes are additive + idempotent** (existing `pragma table_info` migration pattern in `server/src/db.js`). Prod DB backup before deploy (existing flow).
4. **Notifications reuse the existing stack:** insert into `notifications` (bell UI) + Resend email to admins; throttle: max 1 alert per asset per 30 min per event type (AirPinpoint's rule).
5. **Share links follow the `calendar_tokens` precedent** (unguessable token row, created on demand, revocable) — public page server-rendered from Express (no SPA router work), expires.
6. **Tracker cadence:** drop launchd `StartInterval` 1200 → 300 (5 min) to match realistic Find My network update cadence and AirPinpoint's near-real-time feel.

### New schema (all in `server/src/db.js`, additive)

```sql
-- team_members: status columns
equipment_status TEXT DEFAULT 'unknown'   -- unknown|available|checked_out|delivered
status_source    TEXT DEFAULT ''          -- '' | 'manual' | 'geofence'
checked_out_to   TEXT DEFAULT ''          -- person/crew/job (free text or member id)
checked_out_at   TEXT DEFAULT ''
auto_checkin     INTEGER DEFAULT 1        -- honour geofence auto-updates?

CREATE TABLE IF NOT EXISTS equipment_geofences (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL, radius REAL NOT NULL,   -- metres (min 50, max 5000)
  notify INTEGER DEFAULT 1,                                     -- email/bell on entry/exit
  active INTEGER DEFAULT 1,
  created_by TEXT, created_at TEXT DEFAULT (datetime('now','+10 hours')),
  updated_at TEXT DEFAULT (datetime('now','+10 hours'))
);

CREATE TABLE IF NOT EXISTS equipment_geofence_assignments (
  id TEXT PRIMARY KEY, team_member_id TEXT NOT NULL, geofence_id TEXT NOT NULL,
  role TEXT DEFAULT 'checkin',        -- 'checkin' | 'delivery'
  last_inside INTEGER,                -- NULL until first evaluation (transition detection)
  UNIQUE (team_member_id, geofence_id, role),
  FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE,
  FOREIGN KEY (geofence_id) REFERENCES equipment_geofences(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS equipment_events (
  id TEXT PRIMARY KEY, team_member_id TEXT NOT NULL, geofence_id TEXT,
  event TEXT NOT NULL,   -- enter|exit|status_change|battery_low|checkin|checkout
  detail TEXT DEFAULT '', lat REAL, lng REAL,
  notified_at TEXT, occurred_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','+10 hours'))
);
CREATE INDEX IF NOT EXISTS idx_equipment_events_member ON equipment_events(team_member_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE,
  scope TEXT DEFAULT 'map',            -- 'map' | 'member'
  member_id TEXT, expires_at TEXT NOT NULL, revoked INTEGER DEFAULT 0,
  created_by TEXT, created_at TEXT DEFAULT (datetime('now','+10 hours'))
);
```

### New server module: `server/src/services/geofenceEngine.js`

```js
// Called after every equipment_locations insert (ingest + manual update).
export function evaluateEquipment(db, memberId, lat, lng, seenAt) => { events, statusChanged }
//  1. load member (is_equipment, active, auto_checkin, status, status_source)
//  2. for each assignment: inside = haversine(lat,lng, fence) <= radius
//     transition vs assignment.last_inside → equipment_events enter/exit + update last_inside
//  3. recompute status:
//     source==='manual' && status==='checked_out' → stays checked_out
//     else any 'delivery' inside → 'delivered'
//     else any 'checkin' inside  → 'available'
//     else 'unknown'
//  4. statusChanged? → update team_members + event + notify (throttled)
//  5. battery in ('Low','Very Low') and changed → battery_low event + notify (throttled)
```

### New endpoints (`server/src/routes/equipment.js` + index.js mounts)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET/POST | `/api/equipment/geofences` | auth / admin | list / create |
| PUT/DELETE | `/api/equipment/geofences/:id` | admin | edit / delete |
| POST | `/api/equipment/geofences/:id/assign` | admin | assign members (`{members:[], role, mode:'replace'|'add'}` — bulk) |
| POST | `/api/equipment/:id/checkout` | admin | `{to, note}` → manual checked_out |
| POST | `/api/equipment/:id/checkin` | admin | manual available |
| GET | `/api/equipment/events?days=30` | auth | event feed |
| POST | `/api/equipment/share` | admin | `{scope, member_id?, hours}` → `{url}` |
| GET/DELETE | `/api/equipment/share` | admin | list / revoke |
| GET | `/share/:token` | public | server-rendered read-only map page (expiry + revoke checked, `noindex`) |
| POST | `/api/equipment/locations` | (existing) | now calls geofenceEngine per inserted item |

---

## 4. Parity matrix — every AirPinpoint feature

| # | AirPinpoint feature | taskz.id now | Plan |
|---|---|---|---|
| 1 | Live map, all tags, zoom/pan/trails | ✅ | — |
| 2 | Satellite view toggle | ⛔ | Chunk 2: Esri World Imagery + labels toggle |
| 3 | Staleness + accuracy display | ✅ /🟡 | show accuracy m in popup (Chunk 2, S) |
| 4 | Inventory list w/ status + battery + last-seen | 🟡 | Chunk 2: status/battery badges in map sidebar + Equipment list; status filter |
| 5 | Quick stats (available vs out) | ⛔ | Chunk 2: sidebar header counts |
| 6 | 4-level status model | ⛔ | Chunk 1 engine |
| 7 | Auto check-in/out from geofences | ⛔ | Chunk 1 engine (ingest-time) |
| 8 | Circle geofences (10–5000 m) | ⛔ | Chunk 1 API + Chunk 2 map draw UI |
| 9 | Polygon geofences | ⛔ | Chunk 5 (point-in-polygon; MySQL→SQLite: store GeoJSON, JS test) |
| 10 | Delivery geofences | ⛔ | Chunk 1 (`role: 'delivery'`) |
| 11 | Manual check in/out (priority over auto) | ⛔ | Chunk 1 endpoints + Chunk 2 buttons |
| 12 | Bulk edit (geofence assign etc.) | ⛔ | Chunk 4 (list multiselect → assign) |
| 13 | Default geofences per item | ⛔ | skip — assignment UI is per-item (S, optional) |
| 14 | Email alerts (entry/exit, check-in/out, low battery) | 🟡 (Resend wired) | Chunk 1: notifications + email |
| 15 | SMS alerts | ⛔ | Chunk 5 optional (Twilio; BuzzFPV precedent) |
| 16 | Notification throttle 1/30min/device | ⛔ | Chunk 1 |
| 17 | History + timeline playback | 🟡 (30d trail) | Chunk 3: playback modal w/ scrubber |
| 18 | Retention 30–90d + export CSV/JSON | 🟡 | Chunk 3: export endpoint (CSV/JSON) |
| 19 | Battery % / days + reset | 🟡 (label only) | Chunk 2: Low/Very-Low badges; Chunk 2 reset action (S) |
| 20 | Share links (1–168 h, up to 1 yr) | ⛔ | Chunk 3: token + public page + expiry |
| 21 | QR check-in/out scanning | ⛔ | Chunk 4: phone scan page (BarcodeDetector/html5-qrcode) |
| 22 | QR label printing | ⛔ | Chunk 4: print view (`qrcode` lib) |
| 23 | Multi-user + roles | ✅ | extend: geofence mgmt admin-only |
| 24 | Org access control / viewer isolation | ✅ | shared viewer account already scoped |
| 25 | REST API + API keys + 100/min limit | 🟡 (internal) | Chunk 5: read API w/ hashed keys + rate limit |
| 26 | Webhooks (HMAC, 5s/30s/120s retries, log) | ⛔ | Chunk 5 |
| 27 | SDKs (TS/Python) | ⛔ | skip (internal app; OpenAPI doc if ever needed) |
| 28 | Zapier/Make/Pipedream/MCP | ⛔ | unlocked by Chunk 5 webhooks — no work |
| 29 | AI assistant ("Cartographer") | ⛔ | Chunk 5 optional: NL query endpoint over equipment/events |
| 30 | Mobile app (Android/iOS) | 🟡 (responsive + mobile view) | PWA polish only; no native builds |
| 31 | Clickable coords → directions | ⛔ | Chunk 2 (S): Google Maps link in popup |
| 32 | Asset photos | ⛔ | Chunk 4 optional: `photo_url` field |
| 33 | Usage/billing/currency/invoicing | n/a | internal tool — skipped by design |
| 34 | Self-service vs managed tag onboarding | ✅ tracker | ops runbook in `tracker/README.md`; managed = our Apple IDs |
| 35 | Multiple Apple IDs (32-tag sharding) | ✅ | — |

**Net: 4 chunks of real work to full parity** (1–3 are the must-haves; 4–5 complete the surface).

---

## 5. Implementation chunks

### Chunk 1 — Status engine + geofence API + alerts (core of core)
**Files:** `server/src/db.js` (migrations), `server/src/geo.js` (haversine), `server/src/services/geofenceEngine.js` (new), `server/src/routes/equipment.js`, `server/index.js`/`server/src/index.js` (no new mounts needed — extend existing router), `server/test/geofence-engine.test.js` (new).

- [ ] Add migrations + tables above (idempotent, verified via `sqlite3 … pragma table_info`).
- [ ] `geo.js`: `distanceMeters()` haversine; unit tests vs known coords.
- [ ] `geofenceEngine.js`: `evaluateEquipment()` per spec above; pure-ish (db injected) for testability. Cases: first fix (NULL last_inside), enter, exit, multi-fence overlap, manual-checkout lock, battery transition.
- [ ] Wire into `POST /locations` (both tracker + manual paths) — after tx commit, per inserted member.
- [ ] Geofence CRUD + assign endpoints (bulk assign with replace/add mode — mirrors AirPinpoint bulk edit API).
- [ ] Manual check-out/check-in endpoints (set `status_source='manual'`; check-in clears to geofence-evaluated state).
- [ ] Notifications: insert `notifications` rows + Resend email to admins (`is_admin=1`), throttle 1/30 min per (member, event); low-battery rule on battery label change into Low/Very Low.
- [ ] `GET /api/equipment/events` feed endpoint.
- [ ] Tests: `npm test` green (existing 24 + new engine tests); curl script for ingest→event→status flow.

**Verify:** local server, seed a geofence + assign DJI M300, POST a location inside/outside → status flips available↔unknown; enter/exit events + one notification (then throttled). Commit per task.

### Chunk 2 — Map UI: geofences, statuses, satellite, actions
**Files:** `client/src/components/EquipmentMap.jsx`, `client/src/components/EquipmentManager.jsx`, `client/src/api.js`, `client/src/styles.css` (`--eq-*`).

- [ ] Geofence layer: translucent circles (colour by role: checkin=green / delivery=blue), name labels; show/hide toggle.
- [ ] Admin draw/edit: "Add geofence" → click map for centre → drag radius / numeric input (min 50 m) → name + role + notify toggle → save; edit/delete via popup.
- [ ] Pin + row status: colour dot per status + labels (Available / Out / Delivered / Unknown); status filter chips; sidebar header counts (available/out/low battery).
- [ ] Popup actions: Check out (modal: to whom/note) · Check in · Directions (Google Maps) · Play history (opens Chunk 3 modal) · Share (admin) · battery label + accuracy.
- [ ] EquipmentManager: status column/badge; geofence assignment pickers (check-in / delivery) in edit modal; "auto check-in" toggle.
- [ ] Satellite toggle (Esri World Imagery + reference labels; persist preference).
- [ ] Manual update flow now triggers server-side geofence eval (same endpoint) — confirm trail/pins refresh.

### Chunk 3 — History playback + share links + export
**Files:** new `client/src/components/HistoryPlayback.jsx`, `client/src/components/ShareManager.jsx`; `server/src/routes/equipment.js`; `server/src/index.js` (public share route mount).

- [ ] Playback modal: fetch 30d history, slider scrub, animated marker + progressive polyline, play/pause (1 pt/s), day jump.
- [ ] Share links: "Create link" (scope: whole map or single asset; hours 1–168; default 24) → copy URL; manage/revoke list; `share_links` token (crypto.randomUUID hex — follow `calendar_tokens` pattern).
- [ ] Public `GET /share/:token`: server-rendered minimal Leaflet page (CDN) showing live positions (+ trail for scope=member), staleness + "last updated", brand header; `noindex`; handles expiry/revoke → friendly 410 page.
- [ ] Export: `GET /api/equipment/locations/:id/export?days=90&format=csv|json` (CSV uses the safe-cell pattern from drone-ops audit — escape leading `=+-@`).

### Chunk 4 — QR + bulk edit + photos
- [ ] QR labels: print view (asset name/SN + QR encoding `<origin>/scan/<id>`), A4 sheet layout, print CSS.
- [ ] Scan page: phone-open `/scan/:id` (auth required) → asset card → Check in / Check out buttons (reuses Chunk 1 endpoints; `BarcodeDetector` API + `html5-qrcode` fallback).
- [ ] Bulk edit: checkbox column in Equipment list → bulk "Assign geofence / set category / mark serviceable".
- [ ] Optional `photo_url` per asset (link field w/ thumbnail), mirroring info_url/sds_url pattern.

### Chunk 5 — Integrations + polish (post-parity)
- [ ] Read-only public API `/api/v1/equipment` (+ locations/history/geofences) with hashed API keys (admin UI: create/revoke, last-used), 100 req/min per key; OpenAPI JSON.
- [ ] Webhooks: `webhook_endpoints` + `webhook_deliveries`; events on geofence enter/exit + status change + low battery; HMAC-SHA256 (`X-Taskz-Signature`), retries 5s/30s/120s via in-process queue, delivery log UI (admin).
- [ ] Polygon geofences (GeoJSON text column; ray-casting point test; draw tool on map).
- [ ] Optional: SMS alerts (Twilio), utilization report (time-in-fence / idle), NL "ask your fleet" endpoint (LLM).

---

## 6. Risks, limits, decisions

1. **Apple dependency** — Find My is ToS-grey and can break with any Apple release (AirPinpoint carries the identical risk; they mitigate with genuine Apple hardware + dedicated Apple IDs). We use dedicated Apple IDs + the proven FindMy.py stack; keep manual updates + CSV import as fallback. Manual entry is already a first-class path here.
2. **Update cadence & coverage** — positions arrive when a nearby Apple device sees the tag (~5 min typical, hours in remote WA sites). UI already communicates this via staleness badges — keep geofence radii ≥100 m and design alerts as "entered/exited (last known)".
3. **Beeping tags** — standard AirTags chime when moved away from their owner's devices; for gear that travels without crew phones, prefer non-beeping Find My-certified tags (Kmart Smart Tags verified working; industrial MFi tags for long life). Document per-tag choice.
4. **Notification noise** — 30-min throttle + per-fence `notify` toggle; default only entry/exit + low battery.
5. **Prod DB** — additive migrations only; **backup `~/data/ops-schedule.db` before deploy** (existing pattern). Keep `TRACKER_INGEST_KEY` out of git.
6. **Privacy** — equipment-only tagging; don't attach tags to crew vehicles without a written policy.
7. **Status semantics decision** (recommended defaults): manual check-out locks until manual check-in **or** (per-asset `auto_checkin=1`) re-entry into a check-in fence; leaving all fences ⇒ `unknown` (not auto "checked out") — "Out" is only ever explicit or fence-driven, avoiding false alarms.

---

## 7. Verification & deploy

- Local: `npm test` (node --test) + curl flow: create geofence → assign → POST position inside → expect `available` + enter event + 1 notification; POST outside → `unknown` + exit event; manual checkout → `checked_out` (latched); throttle check; share link renders + expires; playback modal scrub.
- Deploy: commit per chunk → `git push origin main` → VPS: DB backup → `cd ~/domains/taskz.id/nodejs && git reset --hard origin/main && npm install && npm run build && touch tmp/restart.txt` (npm at `/opt/alt/alt-nodejs20/root/bin`).
- Verify live: new bundle hash served on taskz.id + endpoints return 401 (not 404) unauthenticated.

---

## 8. Ops runbook — tracker (existing, for reference)

accounts/<apple-id-slug>/ (session + keys) → `sync_airtags.py` every 5 min (after Chunk 0 tweak: `StartInterval` 300 in `com.buzzbot.airtag-tracker.plist`) → `POST taskz.id/api/equipment/locations` with `X-Ingest-Key`. Matching is by `airtag_name` (case-insensitive, must be unique across accounts). Pending: finish Apple sign-in + key export per `tracker/README.md`.
