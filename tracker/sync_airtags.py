#!/usr/bin/env python3
"""
AirTag → Ops-Schedule tracker (multi-account).

Polls Apple's Find My network for every accessory key under
accounts/<acct>/keys/ and pushes the decrypted locations to the
Ops-Schedule API (X-Ingest-Key auth). One Apple ID per account dir,
so tags registered under different Apple IDs produce one combined list.

Layout (each <acct> is one Apple ID):
  accounts/<acct>/
    account.json          # session — created by ./findmy_login.py <acct>
    keys/*.json           # accessory keys — exported from iCloud by
                          #   ./export_keys.sh <acct> <apple-id-email>
                          # (on macOS ≤ 14 you can instead use
                          #   `python -m findmy decrypt` → keys/)

Run: .venv/bin/python sync_airtags.py          # all accounts
     .venv/bin/python sync_airtags.py <acct>   # one account only
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
ACCOUNTS_ROOT = TRACKER_DIR / "accounts"
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


class AccountError(Exception):
    """Account dir exists but is not usable yet (missing session/keys)."""


def list_accounts(only: list[str] | None = None) -> list[Path]:
    if not ACCOUNTS_ROOT.is_dir():
        return []
    dirs = sorted(p for p in ACCOUNTS_ROOT.iterdir() if p.is_dir())
    if only:
        wanted = set(only)
        dirs = [p for p in dirs if p.name in wanted]
    return dirs


def load_account(acct_dir: Path):
    """Load one account's session + accessory keys.

    Returns (account, accessories) or raises AccountError with a fix hint.
    """
    from findmy import AppleAccount, FindMyAccessory

    slug = acct_dir.name
    session_file = acct_dir / "account.json"
    keys_dir = acct_dir / "keys"

    if not session_file.exists():
        raise AccountError(
            f"[{slug}] no session — run ./findmy_login.py {slug} (Apple ID + 2FA)"
        )
    try:
        account = AppleAccount.from_json(session_file)
    except Exception as exc:  # noqa: BLE001
        raise AccountError(
            f"[{slug}] session restore failed ({exc}) — re-run ./findmy_login.py {slug}"
        ) from exc

    if not keys_dir.is_dir():
        raise AccountError(
            f"[{slug}] missing keys dir — run ./export_keys.sh {slug} <apple-id-email>"
        )
    accessories = []
    for path in sorted(keys_dir.glob("*.json")):
        try:
            accessories.append(FindMyAccessory.from_json(path))
        except Exception as exc:  # noqa: BLE001
            log.warning("[%s] skipping bad key file %s: %s", slug, path.name, exc)
    if not accessories:
        raise AccountError(
            f"[{slug}] no valid accessory keys in {keys_dir.name}/ — run "
            f"./export_keys.sh {slug} <apple-id-email>"
        )
    return account, accessories


def fetch_account(acct_dir: Path) -> list[dict]:
    """Fetch + decrypt locations for one account; returns API-ready rows."""
    slug = acct_dir.name
    account, accessories = load_account(acct_dir)

    log.info("[%s] fetching Find My locations for %d accessories…", slug, len(accessories))
    try:
        results = account.fetch_location(accessories)
    except Exception as exc:  # noqa: BLE001
        log.error("[%s] Find My request failed: %s", slug, exc)
        return []

    # Persist refreshed session tokens — do this on every successful fetch so
    # an expired session is noticed early instead of mid-rotation.
    try:
        account.to_json(acct_dir / "account.json")
    except Exception:  # noqa: BLE001
        log.warning("[%s] could not persist refreshed session", slug)

    locations: list[dict] = []
    for accessory, report in (results or {}).items():
        name = getattr(accessory, "name", None) or getattr(accessory, "identifier", None) or "unknown"
        if report is None:
            log.info("[%s]  - %s: no location yet", slug, name)
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
            "[%s]  - %s: %.5f, %.5f (±%sm, %s)",
            slug, name, report.latitude, report.longitude, report.horizontal_accuracy, battery,
        )
    return locations


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


def main(argv: list[str] | None = None) -> int:
    if not INGEST_KEY:
        log.error("TRACKER_INGEST_KEY is not set (check %s)", ENV_FILE)
        return 2

    acct_dirs = list_accounts(argv)
    if not acct_dirs:
        log.error(
            "No account dirs under %s — start with: ./findmy_login.py <acct>  "
            "then  ./export_keys.sh <acct> <apple-id-email>",
            ACCOUNTS_ROOT,
        )
        return 2

    locations: list[dict] = []
    seen_in: dict[str, list[str]] = {}
    failed = 0
    for acct_dir in acct_dirs:
        slug = acct_dir.name
        try:
            locs = fetch_account(acct_dir)
        except AccountError as exc:
            log.error("%s", exc)
            failed += 1
            continue
        for loc in locs:
            seen_in.setdefault(loc["airtag_name"], []).append(slug)
        locations.extend(locs)

    # Names must be unique across accounts — the API matches by name only.
    for name, slugs in seen_in.items():
        if len(set(slugs)) > 1:
            log.warning(
                "Duplicate AirTag name %r in accounts %s — the map will show the "
                "newest report; rename one tag in Find My",
                name, sorted(set(slugs)),
            )

    if not locations:
        return 1 if failed else 0

    ok = push(locations)
    if failed:
        log.warning("%d account(s) failed — fix before next run", failed)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] if len(sys.argv) > 1 else None))
