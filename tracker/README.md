# Find My Tracker (AirTag / Kmart Smart Tag → Equipment Map)

Polls Apple's Find My network for every tracker registered under one or more
Apple IDs and pushes their locations into the Ops-Schedule **Equipment Map**.

```
Find My network ──► FindMy.py (this Mac, every 20 min) ──► POST /api/equipment/locations
                                                          (X-Ingest-Key auth)
                                                                   │
                                                            taskz.id
                                                                   │
                                                            Equipment Map dashboard
```

Matching is by name: the tracker's name in Find My must equal the equipment's
`AirTag Name` field (Equipment tab → Edit → AirTag Name). Names must be unique
across all accounts (the API matches by name only).

## Layout — one directory per Apple ID

```
tracker/
  accounts/
    <acct>/              # e.g. "droneops" — one Apple ID per dir
      account.json       # session (from findmy_login.py)
      keys/*.json        # accessory keys (from export_keys.sh)
  sync_airtags.py        # polls every account, pushes one combined batch
  findmy_login.py        # interactive Apple ID + 2FA sign-in
  export_keys.sh         # exports accessory keys straight from iCloud
```

Works with **any Find My network tag**: genuine AirTags *and* third-party
"Works with Find My" tags (e.g. Kmart/Anko Smart Tag Type-C $20 — not the
Google/Android one).

## Install (once per Mac)

```bash
python3.11 -m venv .venv
.venv/bin/pip install 'findmy>=0.10.2'
```

FindMy **0.10.2 or newer** is required: since Sep 2026 Apple refuses 0.10.1
sign-ins with `Error response for GSA request: 503`.

## Adding an account (per Apple ID, one time)

1. **Sign in** (Apple ID + 2FA — do this in a real terminal, password is not
   echoed):

   ```bash
   .venv/bin/python findmy_login.py <acct>
   ```

2. **Export the accessory keys** straight from iCloud — no Find My setup on
   the Mac needed, works on macOS 26 (`python -m findmy decrypt` only works on
   macOS ≤ 14):

   ```bash
   ./export_keys.sh <acct> <apple-id-email>
   ```

   Interactive: Apple ID password → pick 2FA method (trusted device or SMS) →
   the **passcode of a listed trusted device** (iPhone PIN or Mac login
   password) → escrow password (choose "Generate a random password") → it joins the
   iCloud keychain circle, fetches the Find My accessory list from CloudKit
   and writes one `.json` per tag into `accounts/<acct>/keys/`.

   Requires the Apple ID to have iCloud Keychain escrow bottles (i.e. a
   device with a passcode — any normal iPhone setup qualifies).

   The export includes the owner's iPhones, iPads and Macs as well as tags.
   Move any key files you must never locate out of `keys/`.

3. Configure the push target: the server reads `TRACKER_INGEST_KEY` from a
   `SetEnv TRACKER_INGEST_KEY <key>` line in its `.htaccess`. Generate a key
   with `openssl rand -hex 32` and put the same value **only** in the
   installed launchd plist (below). For manual runs pass it in the
   environment; `.env` holds just `API_URL`.

## Run

```bash
.venv/bin/python sync_airtags.py          # all accounts
.venv/bin/python sync_airtags.py <acct>   # one account
```

launchd (every 20 min, logs to `~/Library/Logs/airtag-tracker/` — launchd cannot write logs on the external /Volumes/Data disk, exit code 78):

```bash
mkdir -p ~/Library/Logs/airtag-tracker
cp com.buzzbot.airtag-tracker.plist ~/Library/LaunchAgents/
chmod 600 ~/Library/LaunchAgents/com.buzzbot.airtag-tracker.plist
# set TRACKER_INGEST_KEY in the INSTALLED copy only — never in the repo copy
launchctl load ~/Library/LaunchAgents/com.buzzbot.airtag-tracker.plist
```

## Gotchas

- Trackers only report when near an Apple device — remote sites show
  "last seen" until someone with an iPhone walks past. Third-party tags
  behave the same as AirTags (no Precision Finding, but we don't use it).
- Kmart Smart Tags are rechargeable (~90 days/charge) — someone must collect
  the gear to charge it. AirTags run ~1 yr on a CR2032.
- FindMy.py is unofficial; Apple may break it. If a session stops working,
  re-run `findmy_login.py <acct>`.
- Hardware security keys as the Apple ID's *only* 2FA won't work.
- The exporter's device profile (`~/Dev/export-findmy/.local/<acct>.toml`)
  stores the escrow password — keep it private.
- Never commit `accounts/`, `account.json`, `keys/`, `.env` (gitignored), or
  a real key in `com.buzzbot.airtag-tracker.plist` — this repo is public.
