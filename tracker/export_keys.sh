#!/bin/bash
# One-time: export Find My accessory keys for an Apple ID straight from iCloud.
# No Mac-side Find My needed — works on macOS 26 (findmy decrypt does not).
#
# Usage: ./export_keys.sh <account-slug> <apple-id-email>
#   Writes FindMy.py-ready JSON keys into accounts/<account-slug>/keys/
#   Uses ~/Dev/export-findmy (stek29 fork, pre-built).
set -euo pipefail

TRACKER="$(cd "$(dirname "$0")" && pwd)"
EXPORTER="${EXPORTER:-$HOME/Dev/export-findmy}"
BIN="$EXPORTER/target/release/export-findmy"

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <account-slug> <apple-id-email>" >&2
  exit 1
fi
ACCT="$1"
EMAIL="$2"

if [ ! -x "$BIN" ]; then
  echo "Exporter not built: $BIN" >&2
  echo "Build it first: cd $EXPORTER && cargo build --release" >&2
  exit 1
fi

PROFILE="$EXPORTER/.local/$ACCT.toml"
OUT="$TRACKER/accounts/$ACCT/keys"
mkdir -p "$(dirname "$PROFILE")" "$OUT"
if [ ! -f "$PROFILE" ]; then
  cp "$EXPORTER/device-profile.template.toml" "$PROFILE"
  echo "Created device profile: $PROFILE"
fi

"$BIN" --apple-id "$EMAIL" --device-profile "$PROFILE" --output-dir "$OUT"

echo
echo "Keys written to accounts/$ACCT/keys/"
echo "Next: name each accessory in Find My to match the equipment's 'AirTag Name'"
ls -1 "$OUT"
