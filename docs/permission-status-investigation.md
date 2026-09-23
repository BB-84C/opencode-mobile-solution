# Permission gates and incomplete status scans — 2026-09-23

## Evidence and cause

The owner's connected iPhone was running 1.0.2 (3) on iOS 27.0 (24A437).
Its session list showed a Woody warning for 57 project directories and a Mac
warning for two directories. The test session `测试权限门禁访问工作区外路径`
(`ses_f3060e795ffeMZ4ZaJoc9psXJz`, Mac, `/Users/bb84`) streamed its transcript,
including the pending bash call, but had no permission controls.

Read-only requests through the existing relay returned a pending permission from
`GET /permission?directory=/Users/bb84`: `external_directory`, command
`cat /etc/hosts`, patterns and always-scope `/etc/*`. The deployed server's
`/doc` schema and responses established the current contract:

- Pending requests are a separate queue, with `permission.asked` and
  `permission.replied` events. They are not transcript permission parts.
- `POST /permission/{requestID}/reply` takes `{reply: once|always|reject, message?}`
  and the directory/workspace query.
- The old `/session/{sessionID}/permissions/{permissionID}` endpoint is deprecated
  and expects a string `response`. The App sent a boolean `response`, additional
  legacy fields, and no directory scope. Even a visible legacy card would submit
  the wrong contract.

The Windows backend enumerated 20,335 session records across 76 directory scopes.
A ten-second read-only scan from the VPS completed 43 successful status reads;
32 scopes were never attempted, and the final request reached the nearly expired
overall deadline. This does not prove every Windows directory is healthy. It does
prove the App's old count incorrectly combined real failures, deadline truncation,
and unattempted scopes. Starting again from the newest directory on each refresh
also prevented consistent progress through older scopes. Network timing changes
therefore changed the displayed failure count without establishing new failures.

`/api/session/active` was considered but returned an empty map even while this
legacy permission-blocked session reported busy through `/session/status`.
It cannot replace directory-scoped status reads for the deployed execution path.

## App changes

- Read the permission queue on session open and reconciliation, and again after
  SSE connects to cover the REST-to-stream gap. Publish the gate immediately,
  independently of optional LSP/MCP/provider initialization.
- Keep requests isolated by connection, machine, and session; deduplicate live
  events; remove resolved requests; prevent older REST responses from resurrecting
  a gate resolved by a newer event or submission. Permission state is not persisted
  as an authoritative offline queue.
- Show a dedicated permission card above the composer with the real command,
  affected patterns, always-scope, three decisions, optional rejection guidance,
  in-flight protection, and recoverable submission errors. The containing scroll
  view uses `flexGrow: 0` so it hugs short cards, while keeping the 40% maximum
  height and scrolling for long requests. Block normal prompt
  submission while a gate is pending. Never automatically approve a gate.
- Submit the current API body and full directory/workspace routing. Mutations
  remain single-attempt, without automatic replay after a network failure.
- Preserve the ten-second status-phase budget and three-second per-request limit.
  Use a fair per-target queue, retain recent results for 30 seconds (five seconds
  for active/running scopes), back off failed scopes, and pace requests by 200 ms.
  Subsequent refreshes reach previously deferred scopes instead of repeating the
  same prefix. Deleted scopes are removed from the scheduling state.
- Count only actual failed reads as warnings. A request cut short by the remaining
  overall budget stays deferred. Show deferred work as a neutral progress note,
  with refresh/open-session options; unknown state is not reported as idle.
  Initial discovery counts exclude previously successful snapshots that have
  expired. Those are identified as previously checked states instead of making
  the initial-check counter grow again.

These are App-side fixes. Neither relay scripts nor backend permission rules were
changed. The owner subsequently tapped Allow once on the iPhone. Readback confirmed
the original request disappeared and the corresponding bash tool completed.
The agent did not submit any permission decision.

## Validation

- TypeScript passed; 59 test files passed and one was skipped: **317 tests passed,
  four skipped**.
- Added coverage for scoped queue/reply contracts, no replay of permission
  decisions, early gate publication, composite routing, event deduplication,
  stale-response rejection, submission failures, reconnect reconciliation,
  prompt blocking, duplicate taps, and fair progress through 76 healthy scopes
  without false failure warnings. After the final expiry-count and layout changes,
  TypeScript and the 52 affected store/screen tests passed, including a 31-second
  gap between refreshes.
- A development-signed Release candidate **1.0.3 (4)** was archived, signature
  verified, and installed over the production bundle with existing data preserved.
  The iPhone screenshot at 15:19 showed the actual pending request, correct command
  and scope, and Allow once / Allow always / Reject controls above the composer.
  The owner then verified Allow once; server readback confirmed completion.
  A later user-created gate for `/var/tmp/*` appeared independently, verifying
  live delivery of a new request.
- The final candidate archive (`opencode-mobile-1.0.3-4-final.xcarchive`) was rebuilt
  with the layout and expiry-count follow-ups, signed, and installed at 15:31.
  Runtime source hashes match
  the repository; JS bundle SHA256 is
  `162e6d122b892024c8e89dba04e5df88690e2690e49c7f279241c3a3aed9fb8e`.
  At 15:33, the final iPhone screenshot of the `/var/tmp/*` request confirmed
  the permission card now ends directly above the composer, without the earlier
  large blank region. The longer command and all three decision buttons remained
  visible. At the time of this device check, the candidate had not yet been
  uploaded. It was later released as [TestFlight 1.0.3 (4)](testflight-1.0.3-release.md).

The final phone status rounds at 15:34 and 15:35 showed 876 root sessions and
no Sync Warning. The unchecked Woody directory count decreased **45 → 24**
across a gap longer than the snapshot cache lifetime, confirming that expired
successful checks did not inflate the initial-discovery count. The remaining
24 scopes were deferred, not verified failures or confirmed idle sessions.

Private device screenshots, build logs, and verification records are kept in the
ignored `app/artifacts/permission-status-20260923/` directory.
