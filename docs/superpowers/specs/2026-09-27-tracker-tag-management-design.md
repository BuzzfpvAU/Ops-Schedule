# Tracker Tag Management — Design (taskz.id V2)

> **Date:** 27 Sep 2026 · **Author:** Claude (from Grant's brief)
> **Brief:** manage which Find My items the AirTag tracker follows and which equipment each one is, from V2 Settings → Tracking — instead of hand-moving key files and matching tags by name.
> **Part 1 of 2.** Part 2 (remote export portal: staff with only a phone sign in through a portal on the tracker Mac, which runs export-findmy for them) gets its own spec and builds on this one.

---

## 1. Problem

Today (verified 26–27 Sep 2026 while setting up the `droneops` account):

- **Matching is by name.** A tag reports only if its Find My name equals an equipment item's `airtag_name` exactly. The first export produced two tags both called "Grant’s Luggage" and names containing a curly apostrophe (’), which a typed straight `'` never matches.
- **The export takes everything.** `export_keys.sh` writes keys for every Find My item on the Apple ID — the owner's iPhone, iPad and Macs as well as tags. The only way to stop the tracker locating a personal device is to move its key files out of `keys/` by hand.
- **Nothing flags a dead tag.** The four droneops tags were last aligned in Aug 2023; the only sign was a sync that returned zero reports.
- **Company-owned tags** (the recommended way to onboard equipment: pair every tag to the droneops Apple ID) still needs a place to pick which exported tags to track and what each one is.

## 2. Decisions

| # | Decision | Chosen |
|---|---|---|
| D1 | Where tag management lives | V2 **Settings → Tracking** on taskz.id (admin only). Keys never leave the tracker Mac — only IDs and metadata do. |
| D2 | How a tag is linked to equipment | By the tag's **permanent identifier** from the export, via an explicit link. `airtag_name` becomes a display label only. |
| D3 | Which items appear | **Everything the export finds**, devices included, each with an include toggle. Every new item starts **excluded**; nothing is located until an admin includes it. Devices carry an "Apple device" badge, sit in a collapsed group, and need a confirmation to include. |
| D4 | Stale alerts | **Settings only**: a Stale badge per tag and a count in the header. One global threshold, default 3 days, editable. No notifications. |
| D5 | Mac ↔ server protocol | **One inventory call per run**: the sync posts its inventory and receives the included IDs in the same response. |

## 3. Data model (server)

New table `tracker_items` — one row per item seen in any export:

| Column | Type | Notes |
|---|---|---|
| `identifier` | TEXT PK | Permanent ID from the export key file (e.g. `2006~#00640403848084a0~#HGLJLL3SP0GV`, `l:/00008142-…`) |
| `account` | TEXT | Account folder under `tracker/accounts/`, e.g. `droneops` |
| `name` | TEXT | Find My name, refreshed every inventory |
| `emoji` | TEXT | From the export, may be empty |
| `model` | TEXT | e.g. `Mac17,2`, `iPad13,11`, empty for tags |
| `serial_number` | TEXT | From the export, may be empty |
| `kind` | TEXT | `tag` or `device` (decided on the Mac, see §5) |
| `included` | INTEGER | 0/1, default **0** |
| `equipment_id` | TEXT NULL | FK → `team_members.id` (is_equipment=1); unique when not null |
| `first_seen_at` | TEXT | ISO time first reported by an inventory |
| `last_inventory_at` | TEXT | ISO time of the most recent inventory that contained it |
| `last_seen_at` | TEXT NULL | Time of the newest location report received for it |
| `battery` | TEXT NULL | From the newest location report |

New table `app_settings` (`key` TEXT PK, `value` TEXT) — the server has no settings store yet. First key: `tracker_stale_days`, default `3` when absent.

`equipment_locations` is unchanged; rows are still written against the linked `team_members.id`.

## 4. API (server/src/routes/equipment.js)

Both tracker-facing endpoints (4.1, 4.2) authenticate with the existing `X-Ingest-Key` (`TRACKER_INGEST_KEY`); admin endpoints use the existing `requireAuth` + `requireAdmin`.

### 4.1 `POST /api/equipment/tracker/inventory` (ingest key)

Request: `{ items: [{ identifier, account, name, emoji, model, serial_number, kind }] }`

Behaviour:
1. Upsert every item: insert new rows with `included = 0`; for existing rows refresh `account, name, emoji, model, serial_number, kind, last_inventory_at`. Never touch `included` or `equipment_id` on update.
2. **Name auto-link (migration path):** for a newly inserted `kind = 'tag'` row, if exactly one active equipment item has an `airtag_name` equal to the tag's name after normalisation (trim, case-fold, ’ ‘ → '), and that equipment is not already linked, set `equipment_id` to it and `included = 1`. This keeps every currently working tag working with no admin action.
3. Respond `{ included: [identifier, …] }` — every row with `included = 1`, regardless of account (the sync filters to the keys it holds).

### 4.2 `POST /api/equipment/locations` (existing, ingest key)

Each location row may now carry `identifier` (preferred) instead of `airtag_name`.

- With `identifier`: look up `tracker_items`. Unknown or not included → count as `unmatched`. Included → update `last_seen_at`/`battery` on the item; if linked, insert the `equipment_locations` row for `equipment_id` as today; if not linked, store nothing else (the item shows "Seen … · not linked").
- With only `airtag_name`: unchanged legacy behaviour, so an older tracker keeps working.

### 4.3 Admin endpoints (requireAuth + requireAdmin)

- `GET /api/equipment/tracker/items` → `{ stale_days, items: [...] }` with each item's fields plus `equipment_name` and a computed `status` (see §6).
- `PATCH /api/equipment/tracker/items/:identifier` with any of `{ included, equipment_id }`. Linking equipment that is already linked elsewhere requires `{ move: true }`; without it the server returns 409 with the current holder so the UI can confirm. `equipment_id: null` unlinks.
- `DELETE /api/equipment/tracker/items/:identifier` — allowed only when the item is missing from the latest inventory for its account (§6); returns 409 otherwise.
- `PUT /api/equipment/tracker/settings` with `{ stale_days }` (integer 1–60).

`GET /api/equipment/tracking-status` gains `tags_total`, `tags_tracked`, `tags_stale`, `devices_hidden` for the header line.

## 5. Tracker Mac (tracker/)

### `sync_airtags.py`

New run order per invocation:
1. Load every account's session and key files (as today).
2. Build the inventory from the key files. **Classification:** `device` if `model` starts with `iPhone`, `iPad`, `Mac`, `Watch` or `AirPods`, or `identifier` starts with `l:/` or `me:/`; otherwise `tag` (covers AirTags and third-party Find My tags).
3. `POST /tracker/inventory`. **If this fails for any reason (network, 401, 5xx, bad JSON) the run logs the error and exits without fetching anything.** It never falls back to fetching every key, so an outage cannot leak excluded items.
4. Fetch locations only for accessories whose identifier is in `included`, per account.
5. Push locations with `identifier` (and `airtag_name` for readability in logs).

Per-account failures (expired session, bad key file) are logged and skipped as today; Apple errors or throttling are logged, whatever was fetched is pushed, and the next scheduled run retries — no retry loop.

### Key files

`accounts/<acct>/excluded/` is retired: its files move back into `keys/`, since exclusion now lives on the server. The droneops devices then appear in Settings as excluded devices.

### Docs and setup copy

`tracker/README.md` and the V2 Settings "Adding an Apple ID" steps are corrected to what setup actually needed on 26 Sep 2026: FindMy **0.10.2** (0.10.1 is refused by Apple with GSA 503), the `SetEnv TRACKER_INGEST_KEY` line in the server's `.htaccess`, the device-passcode prompt in `export_keys.sh`, and the ingest key living only in the installed launchd plist (not `.env`, not the repo). `tracker/__pycache__/` is added to `.gitignore`.

## 6. Settings → Tracking UI (client-v2/src/components/Settings.jsx)

Status tiles and the setup steps stay. A new **Tags** section replaces "What is mapped".

**Header line:** `4 tags · 2 tracked · 1 stale (> 3 days) · 3 devices hidden`, with a "Stale after [3] days" number input that saves on change.

**List**, grouped by account, tags first, then a collapsed "N Apple devices — hidden" group. Each row:
- Include toggle.
- Emoji + Find My name, serial underneath in small text.
- Equipment dropdown (searchable, reusing `lib/search.js`). Equipment already linked shows "(linked to <tag>)"; picking it asks to confirm, then sends `move: true`.
- Status chip, first match wins:

| Status | Rule | Colour |
|---|---|---|
| Missing from export | `last_inventory_at` older than the newest `last_inventory_at` of its account | grey, with a Delete button |
| Not included | `included = 0` | grey |
| Not linked | included, `equipment_id` null | amber |
| Waiting for first report | included + linked, `last_seen_at` null | amber |
| Stale · N days | `last_seen_at` older than `stale_days` | red |
| Seen 2h ago · Full | otherwise | green |

Including a `device` opens a confirm: "This will track the location of <name>, a personal device. Continue?"

Every change saves immediately with a toast (existing V2 pattern) and takes effect on the next sync (≤ 20 min). No "sync now" button. On narrow screens a row stacks: name + toggle, then dropdown, then status.

## 7. Testing

**Server** — `node:test` files in `server/test/`, same harness as `trackingStatus.test.js`:
- inventory upsert: new rows excluded; update never flips `included`/`equipment_id`; response lists included IDs
- name auto-link: exact, case-different and curly-vs-straight apostrophe matches link; ambiguous (two equipment items) or already-linked equipment does not
- locations by identifier: linked → `equipment_locations` row; included-unlinked → only `last_seen_at`; excluded/unknown → unmatched
- legacy `airtag_name` push unchanged
- PATCH link conflict → 409 without `move`, succeeds with it
- DELETE refused unless missing from the latest inventory
- status computation incl. stale threshold from `app_settings`
- ingest key required on inventory; admin required on admin endpoints

**Tracker** — `tracker/test_sync.py` (pytest, added to the venv): classification cases (AirTag, Kmart tag, `l:/` Mac, `me:/` iPhone, iPad model), and inventory failure → zero fetches.

**End to end** — one real sync against taskz.id; Settings → Tracking lists the droneops tags and devices, all excluded except any auto-linked by name.

## 8. Out of scope

Remote export portal (part 2), notifications, per-tag stale thresholds, a "sync now" trigger, and any change to the V1 Equipment Map beyond it continuing to read `equipment_locations`.
