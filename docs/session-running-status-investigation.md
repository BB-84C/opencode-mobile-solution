# Windows session running-state investigation — 2026-09-21

The reported missing running indicator is an App request-scope bug. The deployed
relay successfully returns the Windows session's running status when the request
includes its directory. No relay or Windows/macOS launcher change is needed for
this finding.

## Live evidence

Read-only requests through the deployed relay identified:

- Target: `home-opencode` (Woody), OpenCode `1.18.31`.
- Session: `ses_f92f9db5fffeRvdyVMkmWw34rV`, “检查Artifacts与RL贡献指南”.
- Directory from the server's session metadata: `D:\RL-Science-Trajectory`.
- `GET /session/status` returned `{}` during the initial investigation.
- The same endpoint with this directory returned this session as
  `{ "type": "busy" }`, with one active entry.
- The macOS target reported OpenCode `1.18.30`. Its unscoped status was also
  empty at the time of inspection; the user's earlier successful Mac indicator
  does not establish different API semantics on macOS.

The initial busy observation above was captured in the investigation's SSH tool
output. At the later check (18:25:49 UTC), the directory's status map was empty
and the patched App store resolved the session to `idle`. A subsequent check
confirmed that query-only and query-plus-header requests agreed. This later
observation does not demonstrate a live busy indicator; it verifies that the
patched store follows the current scoped response. No prompt was sent, task
interrupted, or backend restarted during these checks.

The later automated live check used the real session metadata and real
`OpenCodeClient` status transport. Enumeration was restricted to this one
reported session, and local persistence was mocked. Credentials stayed on the
VPS. Its sanitized evidence and diagnostic harness are under the ignored
`app/artifacts/session-status-20260921/` directory.

## Cause and change

`refreshActiveHost` previously combined a machine-wide `/api/session` index with
one unscoped `/session/status` request per machine. OpenCode stores these statuses
in an instance state keyed by directory. A session outside the default instance
therefore appeared in the index without its running status. Opening a session
also omitted an initial status read, so a task that was already busy could stay
incorrectly idle until a later SSE transition arrived.

The relevant upstream implementation is
[SessionStatus at v1.18.31](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/session/status.ts),
which uses
[InstanceState's directory-keyed cache](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/effect/instance-state.ts).
This contract applies to both operating systems. The precise reason the owner's
earlier macOS usage happened to work was not reproduced.

`app/src/store/mobile-store.ts` now:

- Groups a target's enumerated sessions by directory/workspace, preserving the
  server-provided path, and reads status once per scope. Requests within each
  target are sequential to avoid a tunnel burst.
- Applies successful responses only to sessions in that scope. Missing entries
  become idle; failed scopes retain their prior status and produce a sync warning.
- Reads status when opening a session and during reconnection reconciliation.
- Preserves a newer live event or another completed status read when an older
  request is still in flight.

## Validation and release scope

- 58 test files passed, one live-test file skipped: **302 tests passed, four
  skipped**. New regressions cover Windows directory routing, scope isolation,
  request deduplication/concurrency, partial failures, already-busy session entry,
  reconnect completion, and a live event racing a snapshot.
- `npm run typecheck` and `git diff --check` passed.
- `expo export --platform ios` succeeded and produced the updated Hermes bundle.
- The additional single-session live store diagnostic passed against the scoped
  response described above.

The earlier iOS launch investigation's native simulator binaries predate this
status change. Following the owner's release authorization, the updated App
source was included in [TestFlight 1.0.1 (2)](testflight-1.0.1-release.md), which
was uploaded and distributed to the existing internal group. External beta
review was submitted separately.
