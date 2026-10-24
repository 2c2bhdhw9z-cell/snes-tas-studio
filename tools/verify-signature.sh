#!/usr/bin/env bash
# Checks a signed .ipa (or .app) with an outside tool, so we never grade our own homework.
#
#   tools/verify-signature.sh <file.ipa|App.app>
#
# Needs rcodesign (github.com/indygreg/apple-platform-rs). Set RCODESIGN to its path.
set -euo pipefail

TARGET="${1:?usage: verify-signature.sh <file.ipa|App.app>}"
RC="${RCODESIGN:-rcodesign}"

if ! command -v "$RC" >/dev/null 2>&1 && [ ! -x "$RC" ]; then
    echo "rcodesign not found. Set RCODESIGN=/path/to/rcodesign" >&2
    exit 2
fi

WORK=""
cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; }
trap cleanup EXIT

APP="$TARGET"
if [[ "$TARGET" == *.ipa ]]; then
    WORK="$(mktemp -d)"
    unzip -q "$TARGET" -d "$WORK"
    APP="$(find "$WORK/Payload" -maxdepth 1 -name '*.app' | head -1)"
    [ -n "$APP" ] || { echo "no .app inside $TARGET" >&2; exit 1; }
fi

echo "== $APP"
OUT="$("$RC" print-signature-info "$APP" 2>&1)"

# Everything that carries a signature must verify.
VERIFIED=$(grep -c 'signature_verifies: true' <<<"$OUT" || true)
FAILED=$(grep -c 'signature_verifies: false' <<<"$OUT" || true)
echo "signatures that verify: $VERIFIED, that fail: $FAILED"

grep -E 'identifier:|digest_type:|code_digests_count:|executable_segment_flags:|designated\(3\)' <<<"$OUT" || true
grep -E "'(Info|RequirementSet|Resources|Entitlements|DER Entitlements) \([0-9]+\)" <<<"$OUT" || true

if [ "$FAILED" != "0" ] || [ "$VERIFIED" = "0" ]; then
    echo "FAILED: signature did not verify" >&2
    exit 1
fi

"$RC" verify "$APP" >/dev/null 2>&1 && echo "rcodesign verify: no problems detected"
echo "OK"
