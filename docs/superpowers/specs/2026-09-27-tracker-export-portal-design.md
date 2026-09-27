# Tracker Export Portal — Design (part 2)

> **Date:** 27 Sep 2026 · **Author:** Claude (from Grant's brief)
> **Brief:** staff who only have a phone must be able to add their Find My tags to the tracker without a computer — "simple", through an encrypted portal that uses the tracker Mac.
> **Builds on part 1:** `2026-09-27-tracker-tag-management-design.md` (tracker_items, inventory, Settings → Tracking → Tags).

---

## 1. Problem

Exporting a tag's keys needs export-findmy, which runs only on a computer and prompts interactively for the Apple ID password, a 2FA code, the passcode of one of the account's devices, and an escrow password. No phone app can read Find My keys, and only the tag's **owner** account can export them. Today that means sitting at the tracker Mac and typing into a terminal — impossible for staff in other states with only a phone.

## 2. Decisions

| # | Decision | Chosen |
|---|---|---|
| D1 | Whose Apple session locates exported tags | **droneops.** Any signed-in Apple ID can fetch reports for keys it holds, so the staff member's session, keychain membership and escrow bottle are discarded after export; only chosen tag keys remain. |
| D2 | How staff reach the portal | **One-time invite link** created by an admin in V2 Settings → Tracking: single use, expires in 24 h, labelled (e.g. "Sam – WA"). No other login. |
| D3 | What is kept | **Staff choose on their phone.** Tags pre-ticked; iPhones/iPads/Macs unticked under "Your devices". Unticked keys are deleted immediately and never reach the server. Kept items arrive in Settings as excluded (part 1 rules). |
| D4 | How the portal drives export-findmy | **pexpect** over a pseudo-terminal, prompts mapped to phone steps. export-findmy is not modified; its version is pinned and the driver is tested against a fake exporter. |
| D5 | Hosting | Python service on the tracker Mac bound to `127.0.0.1:8765`, exposed as **`https://tags.keyz.au`** through the Cloudflare Tunnel already running on this Mac for keyz.au. |
| D6 | Terminal instructions in Settings | Removed from the page once `TRACKER_PORTAL_URL` is set on the server; they live only in `tracker/README.md`. |

## 3. Flow

1. **Invite (taskz.id).** Admin clicks "Invite someone to add tags", types a label. Server creates a random 32-byte token, stores **only its SHA-256 hash**, label, creator, `expires_at = now + 24h`, `attempts_left = 3`, `status = 'pending'`, and shows `TRACKER_PORTAL_URL/i/<token>` once with a Copy button.
2. **Open link (Mac portal).** Portal calls `POST /api/equipment/tracker/invites/check` with the token (ingest-key auth). Invalid/expired/used/cancelled/no attempts → "This link has expired — ask for a new one." Valid → the portal sets a session cookie (15 min lifetime, `HttpOnly; Secure; SameSite=Strict`) and shows the intro screen.
3. **Intro screen** explains in plain words: what happens, that Apple will show "a new Mac signed in", why the device passcode is needed (reading tag keys from iCloud Keychain), and that everything except the chosen tags is deleted afterwards. Button: Start.
4. **Export session.** Portal records `attempt` (decrements attempts, status `in_progress`), creates a temp dir (mode 700) with a fresh device profile copied from `device-profile.template.toml`, and runs export-findmy there with `--output-dir <temp>/keys --device-profile <temp>/profile.toml --auth-cache <temp>/auth.plist --keychain-state <temp>/keychain.plist` and `EXPORT_FINDMY_ESCROW_PASSWORD` set to a random value. Prompts become phone steps:
   - Apple ID email (asked by the portal and passed as `--apple-id`)
   - password
   - 2FA method choice → code (resend allowed)
   - device passcode (the device name export-findmy lists is shown)
   - escrow password — answered automatically from the env var; staff never see it
5. **Choose.** The phone lists every exported item (name, emoji, kind). Tags ticked; devices unticked under "Your devices". Save.
6. **Keep & report.** Ticked key files (`.json` + `.plist` pairs) move to `tracker/accounts/shared/<slug>/keys/` where `<slug>` is the invite label lower-cased with non-alphanumerics → `-`. Portal posts those items to `POST /api/equipment/tracker/inventory` with `account = "shared/<slug>"`, then `complete` with the count. Status `done`.
7. **Clean up — always** (success, error, abandon, timeout): run export-findmy `--delete-own-escrow-bottle` against the same temp profile to delete the bottle this session created; then delete the temp dir. If bottle deletion fails, call `cleanup-failed` (status `cleanup_needed`). Final phone screen: "Done. On your iPhone, go to Settings → [your name] → Devices and remove '<device name from the profile>'."
8. **Locating.** `sync_airtags.py` gains `LOOKUP_ACCOUNT` (default `droneops`): directories under `accounts/shared/` have keys but no `account.json` and are fetched with the `LOOKUP_ACCOUNT` session. Their inventory rows carry `account = "shared/<slug>"`.

Only one export runs at a time. A second visitor sees "Someone else is adding tags — try again in a few minutes."

## 4. Security

- Password, 2FA code and passcode go from the HTTPS request straight to the pty. They are never written to disk or logs; pexpect `logfile` is `None`; the portal logs step names only.
- Portal binds `127.0.0.1` only; the tunnel is the sole ingress. Cloudflare terminates TLS.
- Session idle 10 min → exporter killed, cleanup runs. Export silent for 90 s → killed, error "Apple isn't responding — try again in 15 minutes".
- 3 attempts per invite. Token checks rate-limited to 10/min per client IP (from `CF-Connecting-IP`).
- The server never returns a token after creation; lookups are by hash with constant-time compare.
- The only persistent artefacts are the chosen tags' key files — which are sufficient to locate those tags until they are reset. `accounts/` stays gitignored, dirs mode 700, files 600.

## 5. Errors (phone copy)

Each session start consumes one of the invite's 3 attempts. "Ends session" = the exporter is stopped, cleanup runs, and the person can start again with the same link while attempts remain.

| Condition (from exporter output / exit) | Phone shows | Ends session |
|---|---|---|
| Wrong password | "Apple didn't accept that password." One retry in the same session | on the 2nd wrong password |
| 2FA code wrong / expired | "That code didn't work." Re-enter or resend | no |
| Only hardware security key | "This Apple ID uses a security key, which this can't work with — ask the office." | yes |
| GSA 503 / anisette error / 90 s silence | "Apple isn't responding — try again in 15 minutes." | yes |
| No accessories found | "No tags found on this Apple ID." | yes |
| Any other non-zero exit | "Something went wrong — ask the office. (ref <short id>)" and the ref + exporter's last error line go to the Mac log | yes |

## 6. Server (taskz.id)

New table `tracker_invites`: `id` TEXT PK, `token_hash` TEXT UNIQUE, `label` TEXT, `created_by` TEXT, `created_at`, `expires_at`, `attempts_left` INTEGER, `status` TEXT (`pending|in_progress|done|expired|failed|cancelled|cleanup_needed`), `tags_saved` INTEGER, `note` TEXT.

Admin (requireAuth + requireAdmin):
- `POST /api/equipment/tracker/invites` `{ label }` → `{ id, url }` (url shown once)
- `GET /api/equipment/tracker/invites` → list (never includes tokens); `expired` is computed when `expires_at` has passed and status is `pending`
- `DELETE /api/equipment/tracker/invites/:id` → status `cancelled` (pending only)

Portal (X-Ingest-Key):
- `POST /api/equipment/tracker/invites/check` `{ token }` → `{ ok, id, label, attempts_left }` or `{ ok: false }`
- `POST /api/equipment/tracker/invites/:id/attempt` → decrements, `in_progress`
- `POST /api/equipment/tracker/invites/:id/complete` `{ tags_saved }` → `done`
- `POST /api/equipment/tracker/invites/:id/failed` `{ note }` → `failed` when no attempts left, else back to `pending`
- `POST /api/equipment/tracker/invites/:id/cleanup-failed` `{ note }` → `cleanup_needed`

`POST /tracker/inventory` accepts optional `portal: { ok: boolean, version: string }`; stored in `app_settings` as `tracker_portal_status` with a timestamp. `GET /tracking-status` adds `portal_url` (from env `TRACKER_PORTAL_URL`, or null) and `portal_last_ok_at`.

Settings → Tracking:
- "Portal" status tile: online if `portal_last_ok_at` < 1 h old.
- Invites section (only when `portal_url` is set): "Invite someone to add tags" (label input → link + Copy), list with status chips and Cancel for pending.
- The collapsed "Tracker Mac setup (admins)" section is not rendered when `portal_url` is set.

## 7. Mac (`tracker/portal/`)

| File | Responsibility |
|---|---|
| `exporter_driver.py` | Spawn export-findmy under pexpect; expose `next_step()` returning one of `need_password`, `need_2fa_method(options)`, `need_code`, `need_passcode(device)`, `found_items(list)`, `error(kind, detail)`, `done`; `answer(value)`. Pure process/prompt logic, no HTTP. Also `delete_bottle(profile)` for cleanup. |
| `session.py` | Single active session: temp dir lifecycle, timeouts, item choice, moving kept keys, cleanup guarantee (`try/finally` + idle reaper thread). |
| `taskz_client.py` | Calls to taskz.id with the ingest key (check, attempt, complete, failed, cleanup-failed, inventory). |
| `server.py` | stdlib `ThreadingHTTPServer` on 127.0.0.1:8765: `GET /i/<token>`, `GET /` (page), `GET /api/state`, `POST /api/answer`, `POST /api/save`, `POST /api/cancel`. |
| `static/index.html` | Single mobile page, one step per screen, polls `/api/state`. No external assets. |
| `tests/fake_exporter.py` | Emulates export-findmy's prompts; scripted scenarios: ok, wrong_password, sms, hardware_key, no_items, hang. |
| `tests/test_driver.py`, `tests/test_session.py` | unittest against the fake exporter. |

Ops:
- `tracker/com.buzzbot.tracker-portal.plist` (launchd, KeepAlive) — like the sync plist, the key is set only in the installed copy.
- `~/.cloudflared` config gains ingress `tags.keyz.au → http://127.0.0.1:8765`.
- `pexpect` added to the tracker venv; README gains an Install line.
- export-findmy pinned at commit `eb5a3a9` (current); the driver's prompt patterns are asserted against that version's strings in tests.

## 8. Testing

- Driver/session: every fake scenario; cleanup runs on success, error, cancel, idle timeout and silence timeout; unticked keys never reach `accounts/shared/` nor the inventory payload; secrets absent from logs (capture log output, assert the password string does not appear).
- Server: invite lifecycle (create → check → attempt → complete; expiry; attempts exhausted; cancel; one-time use), token stored only as hash, admin-only admin endpoints, ingest-key-only portal endpoints, portal status tile data.
- Manual once before real use: one export end-to-end through `https://tags.keyz.au` from a phone with a spare/test Apple ID; confirm the Mac appears under that Apple ID's devices, the bottle is deleted, the temp dir is gone, and the chosen tags appear excluded in Settings.

## 9. Out of scope

Staff linking tags to equipment (admins do it in Settings), concurrent exports, a native app, re-using a staff session for locating.
