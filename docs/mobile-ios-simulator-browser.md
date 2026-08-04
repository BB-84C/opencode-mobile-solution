# OpenCode Mobile iOS Simulator Browser Runbook

Status: native Simulator/browser proof path  
Applies to: `opencode-mobile/`

## What Counts As Proof

The iOS proof must be a real app frame running in iOS Simulator and mirrored into the Codex in-app Browser through `serve-sim`.

This does not count as iOS proof:

- Expo web at `http://localhost:19006`
- A direct HTTP check of the Metro/web server
- A Browser tab that loaded but does not show the Simulator frame

## Commands

Run from `tools/opencode-vps/opencode-mobile` on macOS with Xcode installed:

```bash
npm run ios:sim:doctor
npm run ios:sim:browser
```

`ios:sim:doctor` is only an environment and execution-plan check. It is not native/browser proof by itself.

For a specific simulator:

```bash
npm run ios:sim:browser -- --sim <simulator-udid-or-name>
```

If XcodeBuildMCP already built and launched the app, mirror only that booted simulator:

```bash
npm run ios:sim:browser -- --serve-only --sim <booted-simulator-udid>
```

The script:

1. Fails fast unless it is running on macOS with `xcrun`, `xcodebuild`, and `npx`.
2. Selects a booted iPhone simulator first, or a requested `--sim`.
3. Runs `expo prebuild --platform ios` when no native iOS project exists.
4. Starts Metro in the background, unless `--no-metro` is set.
5. Runs `expo run:ios --no-bundler --device <simulator-udid>` unless `--serve-only` is set.
6. Clears only the scoped mirror for that simulator with `serve-sim --kill <udid>`.
7. Starts `serve-sim <udid>` and prints the URL to open in the Codex in-app Browser.

Keep the script terminal alive while using the Browser mirror. Stop it when finished so the scoped cleanup runs.

## Browser Verification

After `serve-sim` prints its local URL:

1. Open that exact URL in the Codex in-app Browser.
2. Capture a Browser screenshot that visibly contains the Simulator frame.
3. Exercise the app against the real VPS host configured in `codex-e2e-connection.md`.

The screenshot should show the same OpenCode mobile flow being tested, not a placeholder launch screen.

## Current macOS runner result

On 2026-07-12, the target Mac reported:

- `/Library/Developer/CommandLineTools` is selected, but full Xcode is absent.
- `xcodebuild` reports that the active developer directory is only Command Line Tools.
- `xcrun simctl` is unavailable and there are no installed Simulator devices.
- Clean Expo 57 iOS prebuild succeeds and generates the native project plus App Intents
  source/target membership.
- `mas` and `xcodes` are installed, but both Xcode acquisition paths require owner
  authentication (`sudo` password or Apple ID). No credential was entered by automation.

Final native build/run and `serve-sim` proof begin immediately after the owner completes
Xcode installation on this Mac. Web output must not be substituted for that proof.
