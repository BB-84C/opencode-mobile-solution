# OpenCode Mobile iOS App Intents

Status: implemented and verified on iPhone 17 Pro Simulator (iOS 26.5, Xcode 26.6)  
Applies to: `opencode-mobile/`

## Supported system action

The first release exposes one deliberately narrow open-app action:

- **Open OpenCode Sessions**
  - App Intent: `OpenSessionsIntent`
  - Shortcut phrases: `Open sessions in <app>` and `Show OpenCode sessions in <app>`
  - Handoff URL: `opencode://sessions`
  - Expo Router destination: `/two`
  - `openAppWhenRun = true`

There is no system action for creating a session, forking a session, drafting a prompt,
or opening a bare OpenCode session ID. A session is globally identified by the composite
connection + relay target + session key; accepting a free-form session ID at a system
surface would be ambiguous across machines.

`opencode://workbench` remains a compatibility alias for the Sessions screen. Legacy
`opencode://session/...` and `opencode://prompt?...` values are rejected rather than
guessing a machine or reintroducing session creation.

## Native generation and handoff

`opencode-mobile/app.json` registers the `opencode` URL scheme and the
`./plugins/withOpenCodeAppIntents` config plugin. Expo prebuild generates
`ios/opencodemobile/OpenCodeAppIntents.swift` and adds it once to the application target.
The Swift layer contains only the thin `OpenURLIntent` handoff; routing policy remains in:

- `opencode-mobile/src/ux/app-intents.ts`
- `opencode-mobile/app/+native-intent.tsx`

The intent and `AppShortcutsProvider` are marked available on iOS 18 and later without
raising the application's iOS 16.4 deployment target.

## Verification (2026-07-14)

- The generated Swift compiled in the Release application target.
- The installed application contains `Metadata.appintents/extract.actionsdata`.
- Extracted metadata identifies exactly one discoverable action,
  `OpenSessionsIntent`, with exactly one `AppShortcut`, `openAppWhenRun: true`, and no
  parameters or entities.
- The application bundle declares the `opencode` URL scheme.
- `simctl openurl ... opencode://sessions` opened the installed native app on the real
  Sessions screen while preserving the active relay connection and search state.
- TypeScript handoff and config-plugin tests reject legacy prompt/session routes and
  verify idempotent Xcode target insertion.

This is intentionally the smallest useful App Intents surface. Add another intent only
when it can preserve the composite machine/session identity and cannot create or mutate a
conversation without an explicit in-app confirmation.
