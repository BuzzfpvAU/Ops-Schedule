# HANDOFF — 2026-09-27

## Deploying

**A push to `origin/main` is the deploy.** Hostinger's hbuilds watcher rebuilds
and swaps the live app. For server files use `ssh tagz-host` (shared hosting
u882499788, port 65002, `~/.ssh/config`) — the `hermes@srv1713679` VPS in older
notes is wrong. `.htaccess` is `~/domains/taskz.id/public_html/.htaccess`.
Env changes there need an app restart: touching `tmp/restart.txt` did NOT
work; kill the `lsnode:` process (`ps -u $(id -u) -o pid,args | grep lsnode`)
and LiteSpeed respawns it on the next request.
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

## Tracker status (live 27 Sep)

- Server key rotated in `.htaccess` (backup `~/htaccess.taskz.bak-20260927`
  on the host); the old key from git history is rejected (401).
- launchd job loaded — syncs every 20 min, logs in
  `~/Library/Logs/airtag-tracker/`. Each run posts the inventory (8 droneops
  items, all excluded) and locates only included items.
- **No active tags.** The four droneops tags were last aligned Aug 2023. Pair
  real equipment tags to the droneops Apple ID, re-run
  `./export_keys.sh droneops <email>`, then include + link in Settings.

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
