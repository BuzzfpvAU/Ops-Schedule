#!/usr/bin/env python3
"""
AirTag → Ops-Schedule tracker.

Polls Apple's Find My network for every accessory key in ./keys/ and pushes
the decrypted locations to the Ops-Schedule API (X-Ingest-Key auth).

One-time setup:
  1. Enable Find My on this Mac and sign in with the Apple ID that owns the
     AirTags, then export the accessory keys:  `python -m findmy decrypt`
     and save each accessory's JSON into ./keys/
  2. Run ./findmy_login.py once (Apple ID + 2FA) to create ./account.json
  3. Set API_URL + TRACKER_INGEST_KEY in ./.env (see .env.example)

Run: .venv/bin/python sync_airtags.py
"""

from __future__ import annotations

import json
import logging
import os
import sys
import urllib.error
import urllib.request
from datetime import timezone
from pathlib import Path

TRACKER_DIR = Path(__file__).resolve().parent
ACCOUNT_FILE = TRACKER_DIR / "account.json"
KEYS_DIR = TRACKER_DIR / "keys"
ENV_FILE = TRACKER_DIR / ".env"


def _load_env() -> None:
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, val = line.partition("=")
                os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


_load_env()

API_URL = (os.environ.get("API_URL") or "http://localhost:3000").rstrip("/")
INGEST_KEY = os.environ.get("TRACKER_INGEST_KEY") or ""

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("airtag-tracker")

# Status-byte battery bits (see findmy docs)
BATTERY = {0b00: "Full", 0b01: "Medium", 0b10: "Low", 0b11: "Very Low"}


def get_account():
    from findmy import AppleAccount

    if not ACCOUNT_FILE.exists():
        log.error("No session found at %s — run findmy_login.py first.", ACCOUNT_FILE)
        return None
    try:
        return AppleAccount.from_json(ACCOUNT_FILE)
    except Exception as exc:  # noqa: BLE001
        log.error("Could not restore session (%s). Re-run findmy_login.py.", exc)
        return None


def load_accessories():
    from findmy import FindMyAccessory

    if not KEYS_DIR.exists():
        log.error("Missing keys dir %s — export accessory keys first (`python -m findmy decrypt`).", KEYS_DIR)
        return []
    accessories = []
    for path in sorted(KEYS_DIR.glob("*.json")):
        try:
            accessories.append(FindMyAccessory.from_json(path))
        except Exception as exc:  # noqa: BLE001
            log.warning("Skipping %s: %s", path.name, exc)
    return accessories


def push(locations: list[dict]) -> bool:
    payload = json.dumps({"locations": locations}).encode()
    req = urllib.request.Request(
        f"{API_URL}/api/equipment/locations",
        data=payload,
        headers={"Content-Type": "application/json", "X-Ingest-Key": INGEST_KEY},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        log.error("Push rejected (HTTP %s): %s", exc.code, exc.read()[:300])
        return False
    except Exception as exc:  # noqa: BLE001
        log.error("Push failed: %s", exc)
        return False

    log.info(
        "Pushed %s/%s locations (unmatched: %s, invalid: %s)",
        body.get("inserted", 0), len(locations), len(body.get("unmatched", [])), body.get("invalid", 0),
    )
    if body.get("unmatched"):
        log.warning("Unmatched AirTag names: %s", [u.get("airtag_name") for u in body["unmatched"]])
    return True


def main() -> int:
    if not INGEST_KEY:
        log.error("TRACKER_INGEST_KEY is not set (check %s)", ENV_FILE)
        return 2

    acc = get_account()
    if acc is None:
        return 2

    accessories = load_accessories()
    if not accessories:
        return 2

    log.info("Fetching Find My locations for %d accessories…", len(accessories))
    try:
        results = acc.fetch_location(accessories)
    except Exception as exc:  # noqa: BLE001
        log.error("Find My request failed: %s", exc)
        return 1

    locations: list[dict] = []
    for accessory, report in (results or {}).items():
        name = getattr(accessory, "name", None) or getattr(accessory, "identifier", None) or "unknown"
        if report is None:
            log.info(" - %s: no location yet", name)
            continue
        battery = BATTERY.get((report.status >> 6) & 0b11, "Unknown")
        locations.append(
            {
                "airtag_name": name,
                "lat": report.latitude,
                "lng": report.longitude,
                "accuracy": report.horizontal_accuracy,
                "battery": battery,
                "seen_at": report.timestamp.astimezone(timezone.utc).isoformat(),
                "source": "airtag",
            }
        )
        log.info(
            " - %s: %.5f, %.5f (±%sm, %s)",
            name, report.latitude, report.longitude, report.horizontal_accuracy, battery,
        )

    if not locations:
        log.info("Nothing new to push.")
        return 0

    ok = push(locations)
    if ok:
        # Persist refreshed session tokens
        acc.to_json(ACCOUNT_FILE)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
