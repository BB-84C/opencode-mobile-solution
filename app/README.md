# OpenCode Mobile

An OpenCode mobile client built with Expo and React Native. It connects to an
OpenCode relay through QR pairing or a manual relay URL and credential.

## Prerequisites

- Node.js
- Expo tooling

## Run locally

```sh
npm install
npm run ios
npm run android
npm run web
```

## Connect to a relay

The app has no hardcoded relay default. Use the host setup screen to scan a QR
pairing code, or enter your own relay HTTPS URL and credential.

## Build your own app

Before building, update `app.json` with your own app `name`, `slug`, and
`ios.bundleIdentifier` values.

## Installing on an iPhone over USB

The native project lives in `ios/`, which is not tracked here. Two things about
this machine's setup are easy to lose and cost an afternoon each:

**The path cannot contain non-ASCII characters.** CocoaPods reads the Podfile
through Ruby, which fails with `"\xE4" from ASCII-8BIT to UTF-8` as soon as any
directory in the path is non-Latin. Keep the checkout somewhere ASCII-only.

**Pods that predate the current Xcode need their deployment target raised.**
Xcode 27 refuses, rather than warns, below iOS 15, and at least one pod still
declares 13.4. The Podfile's `post_install` lifts every pod to the app's own
minimum; regenerating the project drops that and the build fails again.

Then:

    IOS_TEAM=<your Apple team id> host/renew-ios-app.sh

with the iPhone plugged in and unlocked. It reads the bundle identifier from
`app.json`, regenerates `ios/` with `expo prebuild` and reinstalls pods when
`app.json` or the dependencies changed (retrying flaky downloads), refuses to
build when a dependency with an iOS podspec is missing from `Podfile.lock`, moves
old provisioning profiles aside so Xcode must issue a fresh seven-day one, builds
Release, refuses to install a build signed for fewer than five days, and installs
it. If Xcode is signed out of the Apple ID it says so instead of failing vaguely.
The same script is the renewal: a free Apple ID signs an app for seven days and
an installed copy cannot be extended, so renewing means rebuilding.

To drive it by hand instead, `cd ios && pod install && open
opencodemobile.xcworkspace`, select the iPhone, set the scheme to **Release** (a
Debug build needs Metro running on this Mac and will not launch on its own),
then Run.

If Xcode does not list the iPhone, its device support components are stale:
`sudo xcodebuild -runFirstLaunch`, then reconnect.
