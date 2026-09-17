#!/bin/bash
# Re-signs and reinstalls the iPhone app.
#
# A free Apple ID signs an app for seven days. After that iOS refuses to launch
# it until it is signed again, which means rebuilding and reinstalling: there is
# no way to extend an installed copy in place.
#
# Everything here is what the last renewal actually needed, so the whole thing is
# one command with the phone plugged in:
#
#   host/renew-ios-app.sh
#
# The two constraints that break a rebuild are in app/README.md: the checkout
# must sit on an ASCII-only path, and pods older than the current Xcode need
# their deployment target lifted.

set -u -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_DIR="$(cd "$HERE/../app/ios" 2>/dev/null && pwd)"
TEAM="${IOS_TEAM:-78D4P3U68B}"
SCHEME="opencodemobile"
BUNDLE_ID="com.skylerhu.opencodemobile"
DERIVED="${IOS_DERIVED_DATA:-/tmp/cockpit-ios-release}"

say() { printf '  %s\n' "$*"; }
die() { printf '  %s\n' "$*" >&2; exit 1; }

[ -n "${IOS_DIR:-}" ] && [ -d "$IOS_DIR" ] || die "no ios/ project beside this script; see app/README.md"
if printf '%s' "$IOS_DIR" | LC_ALL=C grep -q '[^ -~]'; then
  die "the checkout path contains non-ASCII characters; CocoaPods cannot read the Podfile from here"
fi

devices="$(xcrun devicectl list devices 2>/dev/null | grep "(UDID)" | grep "physical")"
# A locked phone still lists, as "unavailable"; using its id anyway makes
# xcodebuild complain about the destination specifier instead of the lock.
DEVICE="$(printf '%s\n' "$devices" | grep -vi "unavailable" \
  | grep -oE "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}" | head -1)"
if [ -z "$DEVICE" ]; then
  if [ -n "$devices" ]; then
    die "the iPhone is attached but not usable (devicectl says unavailable); unlock it, and re-plug it if that does not help"
  fi
  die "no iPhone is connected; plug it in, unlock it, and trust this Mac"
fi
say "device $DEVICE"

cd "$IOS_DIR" || die "cannot enter $IOS_DIR"
[ -d Pods ] || {
  say "pods are missing, installing them first"
  PATH="/opt/homebrew/bin:$PATH" pod install >/dev/null 2>&1 || die "pod install failed"
}

say "building (this takes a few minutes)"
log="$(mktemp -t cockpit-ios-renew)"
if ! xcodebuild -workspace "$SCHEME.xcworkspace" -scheme "$SCHEME" \
      -configuration Release -sdk iphoneos -destination "id=$DEVICE" \
      -derivedDataPath "$DERIVED" \
      DEVELOPMENT_TEAM="$TEAM" -allowProvisioningUpdates build >"$log" 2>&1; then
  grep -E "error: " "$log" | grep -v "exit code 0" | head -5 >&2
  die "build failed; full log at $log"
fi

APP="$DERIVED/Build/Products/Release-iphoneos/$SCHEME.app"
[ -d "$APP" ] || die "the build reported success but produced no app at $APP"

# Trust the artefact: an app carrying a profile that is already expiring buys
# nothing, and that is exactly what a stale profile on disk produces.
expiry="$(python3 - "$APP/embedded.mobileprovision" <<'PY'
import datetime, plistlib, subprocess, sys
raw = subprocess.run(['security', 'cms', '-D', '-i', sys.argv[1]], capture_output=True).stdout
expires = plistlib.loads(raw)['ExpirationDate']
print(f"{expires.isoformat()} {(expires - datetime.datetime.utcnow()).days}")
PY
)" || die "could not read the embedded provisioning profile"
days="${expiry##* }"
say "signed until ${expiry%% *} (${days} days)"
[ "$days" -ge 1 ] || die "the new build is already expiring; open Xcode once so it can issue a fresh profile"

say "installing"
xcrun devicectl device install app --device "$DEVICE" "$APP" >/dev/null 2>&1 \
  || die "install failed; unlock the phone and try again"

say "done. $BUNDLE_ID is signed for ${days} more days."
