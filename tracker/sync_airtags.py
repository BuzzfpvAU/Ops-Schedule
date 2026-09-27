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
ANISETTE_LIBS = TRACKER_DIR / "ani_libs.bin"


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
# Keys saved by the export portal (accounts/shared/<slug>/keys) have no
# session of their own; they are located with this account's session.
LOOKUP_ACCOUNT = os.environ.get("LOOKUP_ACCOUNT") or "droneops"
PORTAL_URL = (os.environ.get("PORTAL_HEALTH_URL") or "http://127.0.0.1:8787").rstrip("/")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("airtag-tracker")

# Status-byte battery bits (see findmy docs)
BATTERY = {0b00: "Full", 0b01: "Medium", 0b10: "Low", 0b11: "Very Low"}

DEVICE_MODEL_PREFIXES = ("iPhone", "iPad", "Mac", "Watch", "AirPods")


def classify(model: str | None, identifier: str | None) -> str:
    """'device' for Apple devices (never located unless an admin includes
    them), 'tag' for AirTags and third-party Find My tags."""
    if (model or "").startswith(DEVICE_MODEL_PREFIXES):
        return "device"
    if (identifier or "").startswith(("l:/", "me:/")):
        return "device"
    return "tag"


class AccountError(Exception):
    """Account dir exists but is not usable yet (missing session/keys)."""


def slug_of(acct_dir: Path) -> str:
    return f"shared/{acct_dir.name}" if acct_dir.parent.name == "shared" else acct_dir.name


def is_shared(acct_dir: Path) -> bool:
    return acct_dir.parent.name == "shared"


def list_accounts(only: list[str] | None = None) -> list[Path]:
    """Apple ID accounts first, then portal-shared key dirs."""
    if not ACCOUNTS_ROOT.is_dir():
        return []
    dirs = sorted(p for p in ACCOUNTS_ROOT.iterdir() if p.is_dir() and p.name != "shared")
    shared = ACCOUNTS_ROOT / "shared"
    if shared.is_dir():
        dirs += sorted(p for p in shared.iterdir() if p.is_dir())
    if only:
        wanted = set(only)
        dirs = [p for p in dirs if slug_of(p) in wanted]
    return dirs


def load_account(acct_dir: Path, lookup=None):
    """Load one account's session + accessory keys.

    Returns (account, [(accessory, key_file_json)]) or raises AccountError
    with a fix hint.
    """
    from findmy import AppleAccount, FindMyAccessory

    slug = slug_of(acct_dir)
    session_file = acct_dir / "account.json"
    keys_dir = acct_dir / "keys"

    if is_shared(acct_dir):
        if lookup is None:
            raise AccountError(f"[{slug}] no {LOOKUP_ACCOUNT} session to locate shared keys")
        account = lookup
    elif not session_file.exists():
        raise AccountError(
            f"[{slug}] no session — run ./findmy_login.py {slug} (Apple ID + 2FA)"
        )
    else:
        try:
            account = AppleAccount.from_json(session_file, anisette_libs_path=ANISETTE_LIBS)
        except Exception as exc:  # noqa: BLE001
            raise AccountError(
                f"[{slug}] session restore failed ({exc}) — re-run ./findmy_login.py {slug}"
            ) from exc

    if not keys_dir.is_dir():
        raise AccountError(
            f"[{slug}] missing keys dir — run ./export_keys.sh {slug} <apple-id-email>"
        )
    pairs = []
    for path in sorted(keys_dir.glob("*.json")):
        try:
            meta = json.loads(path.read_text())
            meta["_path"] = str(path)
            pairs.append((FindMyAccessory.from_json(path), meta))
        except Exception as exc:  # noqa: BLE001
            log.warning("[%s] skipping bad key file %s: %s", slug, path.name, exc)
    if not pairs:
        raise AccountError(
            f"[{slug}] no valid accessory keys in {keys_dir.name}/ — run "
            f"./export_keys.sh {slug} <apple-id-email>"
        )
    return account, pairs


def fetch_account(slug: str, account, accessories) -> list[dict]:
    """Fetch + decrypt locations for one account's included accessories;
    returns API-ready rows."""

    log.info("[%s] fetching Find My locations for %d accessories…", slug, len(accessories))
    try:
        results = account.fetch_location(accessories)
    except Exception as exc:  # noqa: BLE001
        log.error("[%s] Find My request failed: %s", slug, exc)
        return []

    # Persist refreshed session tokens — do this on every successful fetch so
    # an expired session is noticed early instead of mid-rotation.
    if not slug.startswith("shared/"):  # shared keys borrow LOOKUP_ACCOUNT's session
        try:
            account.to_json(ACCOUNTS_ROOT / slug / "account.json")
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
                "identifier": getattr(accessory, "identifier", None),
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


def inventory_rows(slug: str, pairs) -> list[dict]:
    rows = []
    for acc, meta in pairs:
        ident = getattr(acc, "identifier", None)
        if not ident:
            continue
        model = getattr(acc, "model", None) or ""
        rows.append({
            "identifier": ident,
            "account": slug,
            "name": getattr(acc, "name", None) or "",
            "emoji": meta.get("emoji") or "",
            "model": model,
            "serial_number": getattr(acc, "serial_number", None) or "",
            "kind": classify(model, ident),
        })
    return rows


def portal_health() -> dict:
    """Whether the export portal on this Mac answers, for Settings' tile."""
    try:
        with urllib.request.urlopen(f"{PORTAL_URL}/healthz", timeout=3) as resp:
            body = json.loads(resp.read())
        return {"ok": bool(body.get("ok")), "version": str(body.get("version") or "")}
    except Exception:  # noqa: BLE001
        return {"ok": False, "version": ""}


def post_inventory(rows: list[dict], portal: dict | None = None) -> dict | None:
    """Report every held key. Returns {"included": ids to locate, "remove":
    ids an admin removed (delete their keys)}, or None on any failure — the
    caller must then locate nothing."""
    req = urllib.request.Request(
        f"{API_URL}/api/equipment/tracker/inventory",
        data=json.dumps({"items": rows, **({"portal": portal} if portal else {})}).encode(),
        headers={"Content-Type": "application/json", "X-Ingest-Key": INGEST_KEY},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read())
        return {"included": set(body["included"]), "remove": set(body.get("remove") or [])}
    except urllib.error.HTTPError as exc:
        log.error("Inventory rejected (HTTP %s): %s", exc.code, exc.read()[:300])
    except Exception as exc:  # noqa: BLE001
        log.error("Inventory failed: %s", exc)
    return None


def delete_key_files(json_path: Path) -> bool:
    """Delete one accessory's key pair (.json + .plist). Refuses anything that
    is not a key file inside ACCOUNTS_ROOT; removes an emptied shared dir."""
    root = ACCOUNTS_ROOT.resolve()
    path = Path(json_path).resolve()
    if path.suffix != ".json" or path.parent.name != "keys" or root not in path.parents:
        log.error("Refusing to delete %s — not a key file under %s", path, root)
        return False
    for f in (path, path.with_suffix(".plist")):
        f.unlink(missing_ok=True)
    keys_dir = path.parent
    if keys_dir.parent.parent.name == "shared" and not any(keys_dir.iterdir()):
        keys_dir.rmdir()
        if not any(keys_dir.parent.iterdir()):
            keys_dir.parent.rmdir()
    return True


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
        log.warning("Unmatched: %s", [u.get("airtag_name") or u.get("identifier") for u in body["unmatched"]])
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

    loaded = []
    failed = 0
    lookup = None
    for acct_dir in acct_dirs:
        # Apple ID dirs sort before shared ones, so the lookup session is
        # loaded by the time shared keys need it.
        try:
            account, pairs = load_account(acct_dir, lookup)
        except AccountError as exc:
            log.error("%s", exc)
            failed += 1
            continue
        if acct_dir.name == LOOKUP_ACCOUNT and not is_shared(acct_dir):
            lookup = account
        loaded.append((slug_of(acct_dir), account, pairs))

    rows = [r for slug, _, pairs in loaded for r in inventory_rows(slug, pairs)]
    reply = post_inventory(rows, portal_health()) if rows else {"included": set(), "remove": set()}
    if reply is None:
        log.error("Inventory not accepted — locating nothing this run")
        return 1
    included, remove = reply["included"], reply["remove"]

    # Items an admin removed in Settings: delete their keys for good.
    for slug, _, pairs in loaded:
        for acc, meta in pairs:
            if getattr(acc, "identifier", None) in remove and meta.get("_path"):
                if delete_key_files(Path(meta["_path"])):
                    log.info("[%s] removed keys for %s", slug, getattr(acc, "name", None) or acc.identifier)

    locations: list[dict] = []
    for slug, account, pairs in loaded:
        wanted = [acc for acc, _ in pairs if getattr(acc, "identifier", None) in included]
        log.info("[%s] %d of %d items included", slug, len(wanted), len(pairs))
        if wanted:
            locations.extend(fetch_account(slug, account, wanted))

    if not locations:
        return 1 if failed else 0

    ok = push(locations)
    if failed:
        log.warning("%d account(s) failed — fix before next run", failed)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] if len(sys.argv) > 1 else None))
