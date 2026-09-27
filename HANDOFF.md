# HANDOFF — 2026-09-27

## Deploying

**A push to `origin/main` is the deploy.** Hostinger's hbuilds watcher rebuilds
and swaps the live app; no SSH is needed (and SSH from this Mac does not work).
Verify by comparing the `/v2/assets/index-*.js` hash on https://taskz.id/v2/
with a local `cd client-v2 && npx vite build`. See `.agent-status.md` → Deploy notes.

## What shipped (27 Sep)

- **AirTag tracker brought up** for the `droneops` Apple ID (session +
  keys exported on this Mac). FindMy pinned to ≥ 0.10.2 — 0.10.1 is refused
  by Apple with GSA 503.
- **Tag management** — V2 Settings → Tracking → Tags. The Mac posts its
  inventory to `POST /api/equipment/tracker/inventory` each run and locates
  only items an admin included; tags link to equipment by permanent
  identifier. Spec: `docs/superpowers/specs/2026-09-27-tracker-tag-management-design.md`.
- **Tracker Mac setup** steps collapsed on the Settings page; new "Tracker
  Mac last reported" tile.
- **Job card fix** — crew can be added to a job with no planned end / no
  planned dates (uses the crew's dates, as kit already did).

## Blocking the tracker going live

1. **Server ingest key.** `.htaccess` still holds the OLD key, which is in
   this public repo's git history. Replace the `SetEnv TRACKER_INGEST_KEY`
   line (hPanel → File Manager → `domains/taskz.id/.htaccess`) with the value
   in `~/Library/LaunchAgents/com.buzzbot.airtag-tracker.plist`, then restart
   the Node app in hPanel. Until then syncs get 401 and locate nothing.
2. **No active tags.** The four droneops tags (Car, Luggage ×2, Backpack) were
   last aligned Aug 2023 and return no reports. Pair real equipment tags to
   the droneops Apple ID, re-run `./export_keys.sh droneops <email>`, sync,
   include + link them in Settings.
3. **launchd job** is installed (`~/Library/LaunchAgents/…`, key inside, mode
   600) but **not loaded** — load it once a real tag is included.

## Open

- **Part 2 — remote export portal** (staff sign in via a portal on this Mac;
  Cloudflare Tunnel + Access; cleans up escrow bottle/profile afterwards).
  Not specced yet. When it ships, remove the terminal steps from Settings
  entirely (keep them in `tracker/README.md`).
- The new key was typed into a zsh session — delete that line from
  `~/.zsh_history`, or rotate the key again.
- Spun off as separate tasks: hard-coded viewer password in
  `server/src/db.js`; `server/src/index.js` (dev entry) does not mount
  `/api/equipment` or `/api/calendar`.
- `deploy/` gitlink dirty, with no `.gitmodules` mapping (unchanged).
