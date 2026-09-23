# Sync cancellation regression — 2026-09-21

The owner reported `FetchRequestCanceledException` and prolonged synchronization
after installing TestFlight 1.0.1 (2). Investigation reproduced a regression in
the directory-scoped status work: the App waited for every historical directory
before publishing a successful session index.

## Evidence

- The connected iPhone 16 Pro runs iOS 27.0 (24A437). `devicectl` confirmed the
  installed production app was 1.0.1 (2).
- A device screenshot showed multiple Mac `/session/status` failures with HTTP
  500, including cloud-backed historical directories. The Windows session
  “检查Artifacts与RL贡献指南” correctly showed RUNNING.
- Relay-side Mac checks fetched 264 metadata records in 0.42 seconds and the empty
  final page in 0.09 seconds. Across 20 directory/workspace scopes, two status
  requests exceeded the diagnostic's eight-second timeout and six returned 500.
- One failing request, `err_5eb2598e`, was traced to OpenCode loading the shared
  `BB84.ai/.opencode/opencode.jsonc`: `FileSystem.readFile` failed with `ETIMEDOUT`.
  macOS reports the file as `compressed,dataless`; File Provider reports
  `isDownloaded=0`. A coordinated read/download timed out at 20 seconds. The file
  contents were not modified.
- Expo wraps native cancellation as an ordinary `Error` with the prefix
  `fetch failed:`. The earlier retry classification missed that form. The App's
  timeout also ended at HTTP headers instead of covering the body read.

## App changes

- Publish the index before directory-status checks, applying status snapshots as
  they arrive. Coalesce concurrent refreshes for the same relay.
- Bound each background directory request to three seconds with one attempt,
  within a ten-second status-phase budget per machine. Recent directories go
  first. This budget does not cap initial session enumeration.
- Report a concise unavailable-directory count while preserving known states.
  Never-fetched states display CHECKING during sync and UNKNOWN after failure.
- Keep the deadline active through response consumption and independently reject
  at the deadline if native cancellation does not settle. Abort the underlying
  request and normalize timeout messages. Retry safe reads only; mutations remain
  single-attempt.

## Validation

- 58 test files passed, one skipped: **307 tests passed, four skipped**.
- TypeScript passed. Added regressions cover Expo cancellation, stalled body
  reads, retries, mutation non-replay, early index publication, duplicate syncs,
  the status-phase budget, and unknown-state rendering.
- Device Release archive **1.0.2 (3)** built and signed successfully, then was
  installed over the existing App using the same production bundle and team.
- The connection remained available. Completed sync showed **871 root sessions:
  64 Mac and 807 Windows**, the named Windows session RUNNING, and a concise
  warning for eight unavailable Mac scopes.
- A cold launch began at 15:28:30 local time. The 15:28:34 screenshot showed the
  usable bounded cache (41 roots); the 15:28:57 screenshot showed the complete
  871-root index and no loading spinner. These are timing upper bounds, not exact
  completion times. The ten-second budget applies only after metadata.

Private screenshots, test logs, device metadata, archive, IPA, and verification
reports are under the ignored `app/artifacts/sync-cancellation-20260921/`
directory. The iPhone currently has the local development-signed 1.0.2 (3)
candidate. A separate distribution export was uploaded as 1.0.2 (3) at 15:34:39
local time and Apple completed processing it. The existing internal group was
added automatically. The 1.0.2 (3) external review was submitted successfully for
the existing Hiren group with automatic tester notification enabled. The page
showed Remove from Review and both test groups. The 1.0.1 (2) review remains
withdrawn.

[TestFlight 1.0.2 (3)](https://appstoreconnect.apple.com/teams/f97f466c-325d-455b-9e6a-bbfef9917c4f/apps/6794705329/testflight/ios/bfe63fff-4ae7-46fe-b8d3-d4ff92879efb)

The matching barcode-scanner framework dSYM was included in this archive.
Apple accepted the upload with remaining dSYM warnings for React,
ReactNativeDependencies, and hermesvm. Those upstream prebuilt symbols were not
available locally; the main App dSYM is included.

## Remaining Mac environment issue

The shared `opencode.jsonc` later became downloaded, and a bounded direct read
successfully read its 1,755 bytes. The service continued returning its earlier
failure. With no registered TUI leases or separate TUI process found, the managed
Mac backend was restarted from generation 19 to 20. A subsequent generation 21
backend and fresh tunnel were observed; the final status reported Ready, local
and public HTTP 200, and OpenCode 1.18.30. Windows remained reachable and the
reported Windows session still returned busy.

The final per-directory check succeeded for 12 of 20 Mac scopes; eight still
exceeded a six-second diagnostic timeout. Open backend file descriptors identified
the remaining cloud placeholders:

- `BB84.ai/.opencode/package.json` — 62 bytes.
- `BB84.ai/general_work/TA Shit/2026 Spring PHYS 1501/opencode.json` — 75 bytes.

Coordinated reads/downloads of both files timed out after 45 seconds, and both
remained `compressed,dataless`. Their contents were not modified. These project
initialization failures remain unresolved and need the files to become locally
available through Google Drive. The App fix prevents them from blocking the
session list or causing unbounded status synchronization; it does not pretend
that those unavailable running states were fetched successfully.
