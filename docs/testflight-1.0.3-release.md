# TestFlight 1.0.3 (4) — 2026-09-23

App: **opencode mobile relay**, App Store Connect ID `6794705329`.
Production bundle: `app.opencodemobile.client`; team: `JDHL7V7RCC`.

## Release state

- GitHub `main` contains the fixes in `efcac5e48cfd967d75012500595784c4be408db2`.
- Xcode upload succeeded at **2026-09-23 15:51:11 America/New_York**; Apple
  processing completed. [Open the TestFlight build](https://appstoreconnect.apple.com/teams/f97f466c-325d-455b-9e6a-bbfef9917c4f/apps/6794705329/testflight/ios/4bacc3f2-a0b7-43e8-b49a-230287637139).
- The **Internal Testers** group received the build automatically and shows
  **Testing**. The **Hiren** external group was added with tester notification
  enabled and submitted to Beta App Review. Its status was **Waiting for
  Review** at the last check. The group had zero enrolled testers at that time.
- The saved What to Test instructions focus on permission decisions, Mac and
  Windows running indicators, repeated refreshes, sync reliability, and iOS 27.

## Included changes and validation

- Restored current OpenCode permission queue/event handling and the scoped reply
  API. The owner tapped Allow once on a real request, and the server confirmed
  the request cleared and the blocked tool completed. A later independent gate
  rendered correctly above the composer, without excess blank space.
- Corrected the running-state warning to count actual failed directory checks,
  while fairly scheduling unqueried scopes. On the final iPhone build, the
  unchecked Woody count fell from **45 to 24** across two refreshes, with 876
  root sessions and no Sync Warning.
- The full pre-final suite passed **317 tests** with four skipped and TypeScript
  passed. After the final layout and progress follow-ups, the **52 affected
  tests** and TypeScript passed. See the
  [investigation](permission-status-investigation.md) for limits of this check.
- Final archive: `opencode-mobile-1.0.3-4-final.xcarchive` (Xcode 26.6,
  iOS 26.5 SDK, minimum iOS 16.4). The signed Release app was installed and
  launched on an iPhone 16 Pro running iOS 27.0 before export.
- Distribution IPA: 17,163,055 bytes, SHA-256
  `d5b1043f1f3962f13f4fb20644b564cff1efba1b439d4cdd514d337a4b1cad8c`.
  It contains version `1.0.3`, build `4`, bundle `app.opencodemobile.client`.

The archive, IPA, Xcode logs, tests, and device evidence are in the ignored
`app/artifacts/permission-status-20260923/` directory. The repository retains
the generic example app identifier and version; production identity was applied
in the local build copy.

Apple accepted the upload with missing dSYM warnings for prebuilt
`React.framework`, `ReactNativeDependencies.framework`, and `hermesvm.framework`.
The matching `ExpoCameraBarcodeScanning.framework` dSYM was added before upload.
The remaining warnings limit symbolication within those prebuilt frameworks.

## App Store submission preparation

The separate App Store iOS version page is still **Prepare for Submission** and
shows version **1.0**; no production App Store review was submitted. If this
binary is used for the first App Store version, align that page to `1.0.3`.

The current App Store Connect record needs iPhone and iPad screenshots (the
binary supports both), description, keywords, support URL, copyright, a selected
build, primary category, content-rights declaration, and age-rating answers.
The App Privacy page has no privacy-policy URL or data-practice answers. Price
and storefront availability are unset. The review section currently requires
sign-in but has no demo credentials or contact details. A disposable, reachable
relay and sample session are needed so App Review can exercise the app without
access to the owner's private coding sessions. Set the desired release mode
before submitting; the page currently defaults to automatic release after
approval. Review EU Digital Services Act account information if distributing
there. The binary declares `ITSAppUsesNonExemptEncryption=false`; verify that
against the actual cryptography used before final submission.
