# iOS 27 launch crash investigation

Date: 2026-09-21. Reported symptom: the latest TestFlight app exits immediately
when opened after an iOS 27 update. App Store Connect confirms the latest build is
**1.0.0 (1), uploaded July 25, 2026**, bundle `app.opencodemobile.client`. Its crash
feedback page says **No Crash Feedback**. The reported incident's root cause is
**not confirmed** because no customer termination report is available.

## Owner's physical-device check

On 2026-09-21, the owner reported that OpenCode opens normally on their own phone
after updating it to iOS 27. The device model and installed app build were not
specified. This is owner-reported evidence, separate from the simulator tests.

This further supports the working hypothesis of a legacy TestFlight build and
large historical cache causing startup memory pressure. It argues against an
unconditional launch failure on iOS 27, but does not establish the affected
tester's termination reason. A possible trigger is a cold launch after the OS
update loading an already oversized cache; that remains an inference.

The next confirmation step is a new TestFlight build containing the cache fix,
tested by the original reporter with their existing app data, or their `.ips`
termination report.

## Changes prepared

- Keep Expo SDK 57 and update the lockfile to Expo 57.0.24 / React Native 0.86.3.
  Align native packages with Expo: Reanimated 4.5.1, Worklets 0.10.1,
  Screens 4.26.2 and the matching Expo modules.
- Add expo-build-properties 57.0.21 and `ios.enableSceneSupport: true`.
  Native generation now uses `EXExpoAppSceneDelegate` and
  `ExpoReactNativeFactoryProvider`, with a single scene configuration.
- Preserve the existing OpenSessionsIntent and `opencode://sessions` route.
  Extracted native metadata contains one discoverable action and one App Shortcut.

[Apple requires scene support for apps built with the iOS 27 SDK](https://developer.apple.com/documentation/uikit/transitioning-to-the-uikit-scene-based-life-cycle).
The actual TestFlight build SDK is **23F81a (iOS 26.5)**, so the iOS-27-SDK scene
requirement does **not** explain this published build's reported crash. The scene
change is forward compatibility for a future SDK 27 build. [Expo documents the SDK 57 opt-in and Hermes fixes](https://expo.dev/changelog/sdk-57);
[the build property requires Expo >=57.0.23](https://docs.expo.dev/versions/v57.0.0/sdk/build-properties/).
These upstream fixes address known compatibility problems; they are not a match
to an unavailable customer crash stack.

## Important distinction between tested packages

| Package | Evidence |
| --- | --- |
| Reported latest TestFlight package | App Store Connect confirms 1.0.0 (1), uploaded July 25, 2026, SDK 23F81a / iOS 26.5, bundle app.opencodemobile.client. No later upload is listed. Crash Feedback is empty; the actual IPA / crash stack was not available. |
| Checkout baseline, before this patch | Built locally with Xcode 26.6 / iOS SDK 26.5. Already contains the August cache fix. Successfully opened Sessions on iOS 27. |
| Previous local installation (`ai.bb84.opencode.mobile`) | Version 1.0.0 (1), SDK 26.5. Its bundled JS contains the v1 cache key but not v2. The existing v1 storage file is 91,637,656 bytes. This is not proof that TestFlight contains the same binary. |
| Patched checkout (`com.example.opencodemobile`) | Release build with bundled JS; normal launch, cold/warm Sessions URL handoff and foreground return verified on iOS 27. |

The cache protection predates this task: commit `6485d0e` (2026-08-05) bounds
session/transcript storage and deletes the old v1 cache natively before reading it.
Its source records a previous 174 MB cache causing launch-time memory termination.
The compatibility candidate includes this existing fix; this task did not author it.
App Store Connect lists no newer TestFlight build after that commit: shipping the
updated source is a necessary next step. This release gap is confirmed; attributing
the customer's particular crash to that cache still requires a termination report.

## Verification

- 58 test files passed, 1 skipped; 298 tests passed, 4 skipped, using
  `vitest run --maxWorkers=2`. The first unrestricted run had one 5-second test
  timeout under host load; the bounded-worker run passed without source changes.
- `tsc --noEmit`, `expo install --check`, and `git diff --check`: passed.
- Baseline and patched Release simulator builds: passed, Xcode 26.6 (17F113).
- Both packages contain `main.jsbundle`. The patched bundle contains the scene
  manifest and extracted OpenSessionsIntent metadata.
- iOS 27.0 (24A434), iPhone 17 Pro simulator: patched Hosts screen displayed;
  cold `opencode://sessions` launch displayed Sessions; returning from Settings
  retained PID 12711; a subsequent warm URL displayed Sessions.
- A synthetic **174,000,000-byte** v1 cache was placed in the dedicated patched
  app's test container. The app cold-launched, deleted the legacy file/key and
  preserved an unrelated sentinel storage key. The Hosts screen displayed.
  No private conversation content was copied into the fixture.
- Native icon interaction was inconclusive while SpringBoard was unresponsive;
  the large-cache cold launch was completed using `simctl launch`.
- iOS 26.5 (23F77) control: the same patched Release package launched and displayed
  Hosts, PID 18066.
- A memgraph was captured on iOS 26.5 after this fresh Hosts launch. The skill's
  leak summary reports **0 leaks / 0 bytes**, physical footprint **64.8 MB**. This is one startup snapshot, not
  proof about long sessions or a before/after leak fix.
- iOS 27 memgraph attempts produced no graph (the baseline attempt stalled and
  was cancelled; the patched attempt reached the 45-second limit).
- The browser mirror displayed the real patched iOS 27 Sessions frame and its
  com.example.opencodemobile bundle identifier. Mirror settings queries timed out;
  that did not prevent frame capture. The mirror was stopped after verification.

No OpenCode application crash report was produced by the successful runs above.
This is evidence for these local builds and flows, not every existing user state
or the unavailable TestFlight binary. URL handoff was tested; a Siri utterance or
complete Shortcuts action invocation has not been tested.

## Controlled comparison with the previous local binary

A further iOS 27 comparison used the preserved old local simulator binary
(`ai.bb84.opencode.mobile`, 1.0.0 (1), SDK 26.5, v1 cache only), not the newer
checkout baseline. This old binary is a proxy for the legacy cache behavior;
it is **not** the downloaded TestFlight IPA. Both test bundle IDs are now installed
on the comparison device; future URL-routing checks should first remove the legacy
test installation or use a fresh device to avoid their shared `opencode` scheme.

| Same iOS 27 simulator, cold launch | Physical footprint | Outcome |
| --- | --- | --- |
| Old local binary, empty cache | Lifetime peak 138.83 MiB | Hosts displayed, no memory guard triggered. |
| Old local binary, 91,637,656-byte synthetic v1 cache | Observed peak at least 573.52 MiB | Exceeded the 512 MiB protection limit at 17.23 seconds; the test sent SIGTERM. Legacy cache remained. |
| Patched binary, identical synthetic cache | Lifetime peak 79.21 MiB | Hosts displayed; legacy cache file/key removed; sentinel key preserved. |

The fixture was a single ASCII text part, with no connections or queued prompts.
Memory came from macOS `proc_pid_rusage`: sampled `RUSAGE_INFO_V2` physical
footprint for the guarded old-cache run, and the kernel's `RUSAGE_INFO_V4`
lifetime maximum for the other runs. The old-cache figure is a sampled lower
bound, not its unconstrained peak. This is startup allocation pressure, not a
before/after leak measurement.

The old app was deliberately stopped by the test guard; this was **not a naturally
observed iOS crash or jetsam event**. The comparison demonstrates a reproducible
legacy-cache memory risk and verifies that the candidate avoids it. A customer's
termination report is still needed to match this mechanism to the reported case.
Some launch clients timed out while the app launched later; process paths,
initialization logs, screenshots and kernel lifetime counters were checked before
recording successful launches. Evidence and one-off test scripts are under
`after-reboot/legacy-*-memory.json`, `fixed-cache-91mb-memory.json`,
`compare-cache-startup.py`, and `measure-legacy-empty.py`. The failed client-level
attempts must not be interpreted as application crashes.

## Environment and artifacts

Host: macOS 26.5.2, Xcode 26.6, iOS SDK 26.5. iOS 27.0 runtime was installed from
Apple with `xcodebuild -downloadPlatform iOS -buildVersion 27.0 -architectureVariant arm64`.
The owner rebooted the Mac at 11:51:26 EDT. Simulator initialization still caused
heavy CPU/memory pressure; keeping one simulator booted and using a fresh device
allowed native app runs. The earlier device also stalled in CoreSimulator service
lookup (`host_support`, 405/1102, IPC -308). Those failures belong to the test
environment and are not application crash evidence.

- Initial iOS 27 device: `8708D96F-75B6-4356-95A6-52E1767B54C6`.
- Clean iOS 27 verification device: `5F6BEC14-EEAB-47D2-B902-A641ADE6135E`.
- iOS 26.5 control: `A4318701-E6C9-4842-BAEB-53A13E841585`.
- Saved, git-ignored artifacts: `app/artifacts/ios27-20260921/`.
  This includes full build logs, test results, `opencodemobile-fixed.app` (47 MB),
  `opencodemobile-baseline.app` (87 MB), and `after-reboot/` screenshots, console
  logs and native cache-fixture results. These are simulator apps, not phone IPAs.
- The original pre-reboot temporary build directories were removed by reboot;
  saved app bundles remain available. Working copies after reboot are in
  `/private/tmp/opencode-ios27-after-reboot/`.

## Remaining uncertainty and release requirements

The latest TestFlight build has now been identified. Its SDK excludes the specific
SDK-27-only scene assertion hypothesis. Obtain the affected device's `.ips` /
termination report to distinguish memory termination from other native/JS startup
failures. An empty Crash Feedback page and a dash in the build's crash metric must
not be interpreted as proof that no crashes occurred.

A future Xcode 27 build still needs separate verification of the SDK 27 link
requirement; it is not necessary to explain the existing SDK 26.5 TestFlight build. [Xcode 27 requires macOS 26.6 or newer](https://developer.apple.com/xcode/system-requirements);
this Mac has 26.5.2. The successful simulator tests above use the iOS 26.5 SDK on
the iOS 27 runtime and must not be described as an Xcode 27 build.

Native dependency and scene changes require a rebuilt native app; a JS-only update
cannot apply them. The saved simulator apps use the repository's example bundle
ID and must not be submitted as production binaries. No upload or tester changes
were performed during the diagnostic phase.

Following the owner's subsequent release authorization, a separate production
device archive was built with `app.opencodemobile.client` and uploaded as
[TestFlight 1.0.1 (2)](testflight-1.0.1-release.md). It includes both the cache
protection and the directory-scoped running-state fix. Internal distribution is
available, and external beta review was submitted. The original affected user's
data-preserving upgrade retest or termination report is still needed to confirm
that their reported crash has been resolved.

An updated Developer Program License Agreement notice appeared during the earlier
read-only investigation. The assistant did not accept any agreement; no agreement
block prevented the subsequent upload.

Private build-page evidence is saved under
`app/artifacts/ios27-20260921/after-reboot/testflight-build-evidence.json`. The
iOS 26.5 memgraph and summary are under `after-reboot/fixed-ios26-memory/`.
