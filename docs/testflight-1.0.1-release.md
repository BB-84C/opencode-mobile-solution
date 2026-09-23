# TestFlight 1.0.1 (2) — 2026-09-21

App: **opencode mobile relay**, App Store Connect ID `6794705329`.
Production bundle: `app.opencodemobile.client`; team: `JDHL7V7RCC`.

## Release state

**Superseded during testing:** the owner found a synchronization regression.
The 1.0.1 (2) external review was subsequently withdrawn while preparing 1.0.2 (3).
See the [sync cancellation investigation](sync-cancellation-investigation.md).

- Signed arm64 iPhoneOS Release archive and App Store distribution IPA built.
- Upload succeeded at **2026-09-21 14:45:32 America/New_York**.
- Apple finished processing the build, and the existing **Internal Testers**
  group received it automatically. App Store Connect subsequently showed the
  existing internal tester as **Installed 1.0.1 (2)** on iOS 27.0.
- Test instructions were saved, including upgrading with existing app data and
  checking already-running Windows sessions.
- The existing **Hiren** external group was added, and **Submit for Review**
  completed successfully. The build page showed **Remove from Review** and both
  groups. External testing is awaiting Apple's beta review; automatic tester
  notification after approval was enabled.
- [Open the TestFlight build](https://appstoreconnect.apple.com/teams/f97f466c-325d-455b-9e6a-bbfef9917c4f/apps/6794705329/testflight/ios/2a26a432-3314-4a66-8689-5bfc89d27298).

## Included changes

- Existing August 5 cache protection: remove oversized legacy v1 session caches
  before reading them and use bounded v2 caching.
- Updated Expo / React Native dependencies and Expo scene support from the
  [iOS launch investigation](ios27-crash-investigation.md).
- Directory-scoped session running-state reads for synchronization, session entry,
  and reconnect, described in the
  [Windows status investigation](session-running-status-investigation.md).

## Build and validation

- Xcode 26.6, iOS 26.5 SDK, minimum iOS 16.4; arm64 device build.
- 302 App tests passed, TypeScript check passed, iOS Hermes export passed before
  the release archive was built.
- Archive and IPA signature verification passed. Distribution entitlements have
  `get-task-allow=false` and `beta-reports-active=true`.
- Archived JS bundle verified to contain the v2 cache and scoped-status fix.
- IPA size: 17,146,218 bytes; exported IPA SHA-256:
  `4c5bbf84d36175d87029920ecae554ebc7ee2beb9e855ccbe45c6d4eb38bb9c7`.

The release uses an isolated local build directory and a production configuration
override (version `1.0.1`, build `2`, production bundle and team). The repository's
generic example bundle identifier remains unchanged. Input hashes, production
configuration, export/upload options, build logs, archive, and exported IPA are
saved under the ignored `app/artifacts/testflight-20260921/` directory. The archive
includes the working-tree fixes; no Git release tag was created.

## Symbol-upload warnings

Apple accepted the upload with missing dSYM warnings for
`ExpoCameraBarcodeScanning.framework`, `React.framework`,
`ReactNativeDependencies.framework`, and `hermesvm.framework`. The main App dSYM
and other available framework dSYMs are present in the archive.

The matching ExpoCameraBarcodeScanning dSYM was subsequently found and preserved
under `supplemental-dSYMs/` in the release artifacts. The installed prebuilt Pods
did not contain dSYMs for the other three frameworks. Supplemental symbol upload
has not been performed. These warnings did not prevent the app upload, but they
limit symbolication for frames inside the affected frameworks.
