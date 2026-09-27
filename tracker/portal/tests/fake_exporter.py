#!/usr/bin/env python3
"""Stand-in for export-findmy with the same prompts (see plan's prompt table).

FAKE_SCENARIO: ok | two_bottles | sms | bad_password | hardware_key |
no_items | hang | unavailable | no_bottles
FAKE_ITEMS (ok): JSON list of {"name","model","identifier","emoji"}.
Delete mode (--delete-own-escrow-bottle): FAKE_BOTTLE_SERIALS comma list;
succeeds when the chosen serial is typed back.
"""
import getpass
import json
import os
import sys
import time


def err(s="", end="\n"):
    sys.stderr.write(s + end)
    sys.stderr.flush()


def arg(name):
    a = sys.argv
    return a[a.index(name) + 1] if name in a else None


def delete_mode():
    serials = [s for s in os.environ.get("FAKE_BOTTLE_SERIALS", "").split(",") if s]
    err("[1/3] Connecting to anisette server...")
    err("[2/3] Authenticating Apple ID...")
    err("  Loaded cached authentication")
    err("[3/3] Setting up escrow maintenance...")
    err(f"Found {len(serials)} escrow bottle(s):")
    for i, s in enumerate(serials):
        err(f"  [{i}] Device {i} (iPhone)")
        err(f"      serial: {s}, build: 21E219, escrowed: 2026-09-27")
    err()
    err("WARNING: This list may include bottles belonging to real Apple devices.")
    sel = input_prompt("Choose a bottle to delete, or press Enter to cancel: ")
    if not sel:
        err("Deletion cancelled.")
        return 0
    i = int(sel)
    err(f"Selected: Device {i} (iPhone) (serial {serials[i]})")
    getpass_prompt("Escrow password [press Enter to use the saved profile password]: ")
    err("Escrow bottle unlocked successfully.")
    if input_prompt(f"Type DELETE {i} to permanently delete this escrow bottle: ") != f"DELETE {i}":
        err("Deletion cancelled.")
        return 0
    if input_prompt(f"Final confirmation: type the device serial {serials[i]}: ") != serials[i]:
        err("Deletion cancelled.")
        return 0
    err(f"Deleted escrow bottle: Device {i} (iPhone)")
    return 0


def input_prompt(p):
    err(p, end="")
    return sys.stdin.readline().strip()


def getpass_prompt(p):
    return getpass.getpass(p, stream=sys.stderr)


def main():
    if "--delete-own-escrow-bottle" in sys.argv:
        return delete_mode()
    sc = os.environ.get("FAKE_SCENARIO", "ok")
    out = arg("--output-dir")
    err("Using device profile: x")
    err("[1/7] Connecting to anisette server...")
    if sc == "unavailable":
        err("Error: Error response for GSA request: 503")
        return 1
    err("[2/7] Authenticating Apple ID...")
    if sc == "hang":
        time.sleep(3600)
    pw = getpass_prompt("Password: ")
    if sc == "bad_password" or pw == "wrong":
        err("Error: AuthSrpWithMessage(-20101, \"Your Apple ID or password was incorrect.\")")
        return 1
    if sc == "hardware_key":
        err("Error: security key required for this Apple ID")
        return 1
    err("  0 - Trusted Device")
    if sc == "sms":
        err("  1 - SMS (•••• •••• 12)")
    input_prompt("Method [0]: ")
    code = input_prompt("Code: ")
    if code == "000000":
        err("Error: AuthSrpWithMessage(-21669, \"Incorrect verification code.\")")
        return 1
    err("  Logged in (dsid=1)")
    err("[3/7] Fetching MobileMe delegate...")
    err("[4/7] Setting up CloudKit & Keychain...")
    err("[5/7] Joining iCloud Keychain trust circle...")
    if sc == "no_bottles":
        err("No usable escrow bottles found.")
        err("Error: No usable escrow bottles found. Confirm iCloud Keychain is enabled on a trusted Apple device and that device has a passcode.")
        return 1
    bottles = ["Sam's iPhone (iPhone) (serial AAA)"] + (["Sam's iPad (iPad) (serial BBB)"] if sc == "two_bottles" else [])
    err(f"  Found {len(bottles)} escrow bottle(s):")
    for i, b in enumerate(bottles):
        err(f"    [{i}] {b.split(' (serial')[0]}")
        err("        serial: X, build: 21E219, escrowed: 2026-09-27")
    idx = 0
    if len(bottles) > 1:
        idx = int(input_prompt("  Choose bottle [0]: ") or 0)
    err(f"  Using escrow bottle from device: {bottles[idx]}")
    getpass_prompt("  Enter the passcode of that device: ")
    err("  Joined keychain trust circle!")
    err("[6/7] Fetching FindMy accessories from CloudKit...")
    err("[7/7] Writing plist and json files...")
    items = json.loads(os.environ.get("FAKE_ITEMS", "[]"))
    if sc == "no_items" or not items:
        err("  No accessories found!")
        return 0
    os.makedirs(out, exist_ok=True)
    for it in items:
        base = it["identifier"].replace("/", "_").replace(":", "_").replace("~", "_").replace("#", "_")
        with open(os.path.join(out, base + ".json"), "w") as f:
            json.dump({"type": "accessory", "name": it["name"], "model": it.get("model", ""),
                       "identifier": it["identifier"], "emoji": it.get("emoji", ""),
                       "serial_number": "", "master_key": "00", "skn": "00", "sks": "00",
                       "paired_at": "2026-01-01T00:00:00+00:00"}, f)
        open(os.path.join(out, base + ".plist"), "w").write("<plist/>")
    err()
    err(f"Done! Exported {len(items)} accessory file pair(s) (plist + json) to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
