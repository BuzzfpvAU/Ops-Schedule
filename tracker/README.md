# AirTag Tracker

Polls Apple's Find My network for the AirTags paired to the business Apple ID
and pushes their locations into the Ops-Schedule **Equipment Map**.

## How it works

```
Find My network ──► FindMy.py (this Mac) ──► POST /api/equipment/locations
                                              (X-Ingest-Key auth)
                                                     │
                                              taskz.id (or localhost:3000)
                                                     │
                                              Equipment Map dashboard
```

Matching is by name: the AirTag's name in Find My must equal the equipment's
`AirTag Name` field (Equipment tab → Edit → AirTag Name).

## One-time setup

1. **Enable Find My on this Mac** — System Settings → your Apple ID →
   Find My Mac → ON, then open the Find My app once and let it sync.
   (The Mac must be on the same Apple ID as the AirTags.)
2. **Export the accessory keys** — from this directory:

   ```bash
   .venv/bin/python -m findmy decrypt
   ```

   Save each accessory's JSON output into `keys/` (one file per accessory).
3. **Sign in** (Apple ID + 2FA — do this in a real terminal):

   ```bash
   .venv/bin/python findmy_login.py
   ```

   This creates `account.json` (session persists; re-run only if it expires).
4. **Configure the push target** — `cp .env.example .env` and set
   `API_URL` + `TRACKER_INGEST_KEY` (must match the server's
   `TRACKER_INGEST_KEY` env var).

## Run

```bash
.venv/bin/python sync_airtags.py        # once
```

launchd (every 20 min, logs to `logs/`):

```bash
mkdir -p logs
cp com.buzzbot.airtag-tracker.plist ~/Library/LaunchAgents/
# edit API_URL + TRACKER_INGEST_KEY inside the plist first
launchctl load ~/Library/LaunchAgents/com.buzzbot.airtag-tracker.plist
```

## Gotchas

- AirTags only report when near an Apple device — remote sites show
  "last seen" until someone with an iPhone walks past.
- FindMy.py is unofficial; Apple may break it. If sessions stop working,
  re-run `findmy_login.py`.
- Hardware security keys as the Apple ID's *only* 2FA won't work.
- Never commit `account.json`, `keys/`, `.env` (all gitignored).
