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
TEAM="${IOS_TEAM:-}"
SCHEME="opencodemobile"
APP_JSON="$HERE/../app/app.json"
BUNDLE_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["expo"]["ios"]["bundleIdentifier"])' "$APP_JSON" 2>/dev/null)"
DERIVED="${IOS_DERIVED_DATA:-/tmp/cockpit-ios-release}"

say() { printf '  %s\n' "$*"; }
die() { printf '  %s\n' "$*" >&2; exit 1; }

[ -n "$TEAM" ] || die "set IOS_TEAM to your Apple Developer team id (Xcode > Settings > Accounts), e.g. IOS_TEAM=ABCDE12345 $0"
[ -n "$BUNDLE_ID" ] || die "could not read expo.ios.bundleIdentifier from $APP_JSON"
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
# Pods must track package.json. Installing them only when Pods/ was absent let 1.2.0's
# react-native-webview and react-native-uitextview ship as JS with no native side, which
# kills the app the moment a session renders a message (2026-10-16).
APP_DIR="$(cd "$IOS_DIR/.." && pwd)"
if [ ! -d Pods ] || [ ../package.json -nt Pods/Manifest.lock ] || [ ../package-lock.json -nt Pods/Manifest.lock ] \
   || [ ../app.json -nt Pods/Manifest.lock ] \
   || ! python3 "$HERE/check-native-deps.py" "$APP_DIR" >/dev/null 2>&1; then
  # ios/ is generated from app.json and the installed packages. Without this the
  # version, name and permissions stayed whatever the first prebuild wrote: a
  # 2.0.0 checkout built a binary labelled 1.1.0 (2026-10-24).
  say "regenerating the native project from app.json"
  (cd "$APP_DIR" && CI=1 EXPO_NO_GIT_STATUS=1 npx expo prebuild --platform ios --no-install >/dev/null 2>&1) \
    || die "expo prebuild failed; run 'npx expo prebuild --platform ios' in app/ to see why"
  say "native dependencies changed since the last pod install, installing pods"
  # A Podfile.lock written for the old versions makes CocoaPods refuse the new
  # ones ("could not find compatible versions", seen after expo 57.0.24 -> 57.0.31).
  # ios/ is generated and untracked, so the lock is safe to drop and resolve again.
  rm -f Podfile.lock
  # pod install downloads React Native's prebuilt core from Maven, and a dropped
  # connection mid-download fails the whole run (2026-10-23). Retry before giving up.
  pod_log="$(mktemp -t cockpit-ios-pods)"
  for attempt in 1 2 3; do
    PATH="/opt/homebrew/bin:$PATH" pod install >"$pod_log" 2>&1 && break
    [ "$attempt" -lt 3 ] || { grep -E "\[!\]|Failed to download" "$pod_log" | head -3 >&2; die "pod install failed three times; full log at $pod_log"; }
    say "pod install failed (attempt $attempt), retrying"
    sleep 10
  done
fi
python3 "$HERE/check-native-deps.py" "$APP_DIR" >&2 \
  || die "some JS dependencies have no native side; run 'npm install' in app/ and then pod install in app/ios"

# Xcode reuses any profile on disk that has not expired yet, even one with a day
# left, so a "renewal" re-signed with the old expiry and reported success
# (2026-10-28). Move this app's profiles aside so the build has to fetch a fresh
# seven-day one; they come back if the build fails.
PROFILE_DIR="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
PROFILE_STASH="$(mktemp -d -t cockpit-ios-profiles)"
stashed="$(python3 - "$PROFILE_DIR" "$PROFILE_STASH" "$TEAM.$BUNDLE_ID" <<'PY'
import glob, os, plistlib, shutil, subprocess, sys
src, dst, wanted = sys.argv[1:4]
moved = 0
for path in glob.glob(os.path.join(src, '*.mobileprovision')):
    try:
        profile = plistlib.loads(subprocess.run(['security', 'cms', '-D', '-i', path], capture_output=True).stdout)
    except Exception:
        continue
    if profile.get('Entitlements', {}).get('application-identifier') == wanted:
        shutil.move(path, os.path.join(dst, os.path.basename(path)))
        moved += 1
print(moved)
PY
)" || die "could not set the old provisioning profiles aside"
restore_profiles() {
  mkdir -p "$PROFILE_DIR"
  for old in "$PROFILE_STASH"/*.mobileprovision; do
    [ -e "$old" ] && mv -n "$old" "$PROFILE_DIR/"
  done
  rmdir "$PROFILE_STASH" 2>/dev/null
}
say "set aside $stashed old profile(s) so Xcode issues a fresh one"

say "building (this takes a few minutes)"
log="$(mktemp -t cockpit-ios-renew)"
if ! xcodebuild -workspace "$SCHEME.xcworkspace" -scheme "$SCHEME" \
      -configuration Release -sdk iphoneos -destination "id=$DEVICE" \
      -derivedDataPath "$DERIVED" \
      DEVELOPMENT_TEAM="$TEAM" -allowProvisioningUpdates build >"$log" 2>&1; then
  grep -E "error: " "$log" | grep -v "exit code 0" | head -5 >&2
  restore_profiles
  if grep -q "No Accounts" "$log"; then
    die "Xcode is signed out of the Apple ID, so it cannot issue a profile. Open Xcode > Settings > Accounts, add the Apple ID, then run this again"
  fi
  die "build failed; full log at $log (old profiles restored)"
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
# A fresh free-account profile lasts seven days. Anything shorter means the old
# one was used after all, and installing it would only look like a renewal.
if [ "$days" -lt 5 ]; then
  restore_profiles
  die "the build was signed with a profile that has only ${days} day(s) left, so nothing was renewed; open Xcode > Settings > Accounts and check the Apple ID is still signed in"
fi
rm -rf "$PROFILE_STASH"

say "installing"
xcrun devicectl device install app --device "$DEVICE" "$APP" >/dev/null 2>&1 \
  || die "install failed; unlock the phone and try again"

say "done. $BUNDLE_ID is signed for ${days} more days."
