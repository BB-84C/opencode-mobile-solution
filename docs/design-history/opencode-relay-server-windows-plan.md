# OpenCode Windows Relay-Server Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the TUI-owned serve/restart wrapper with a user-scoped Windows controller that manages one authenticated OpenCode backend on `127.0.0.1:4096`, supports explicit lifecycle commands, and makes bare `opencode` attach-or-fallback deterministically.

**Architecture:** Keep `opencode.cmd` as a thin dispatcher. Put reusable environment, state, ownership, probe, mutex, and lease functions in one PowerShell module; put lifecycle commands and interactive launch behavior in separate scripts. Verify on a fake backend and alternate port before requesting permission for the live 4096 cutover.

**Tech Stack:** PowerShell 7.4+, Windows process/TCP APIs, OpenCode 1.17.x HTTP API, Node.js fake HTTP fixture, plain PowerShell assertion harness. No additional package installation.

**Execution constraints:** Work in the existing checkout/config tree; do not create a worktree. Do not commit unless explicitly authorized. Do not stop, restart, or replace the current port-4096 backend until the live-cutover gate is separately approved.

---

## File structure

- Create: `C:\Users\example\.config\opencode\bin\opencode-relay-common.psm1` — configuration, auth, state, mutex, listener ownership, process identity, health probes, and leases.
- Create: `C:\Users\example\.config\opencode\bin\opencode-relay-server.ps1` — `start`, `status`, `restart`, `restart tunnel`, `stop`, `stop tunnel`, and `doctor` command surface.
- Create: `C:\Users\example\.config\opencode\bin\opencode-launch.ps1` — interactive classification, authenticated preflight, attach process ownership, and explicit local fallback.
- Create/test first: `D:\workspace\project\.reports\opencode-controller-tests\staging\opencode.cmd` — staged dispatcher candidate.
- Modify only at permission-gated cutover: `C:\Users\example\.config\opencode\bin\opencode.cmd` — install the tested dispatcher and remove the custom `-u` usage collision.
- Retire after live acceptance: `C:\Users\example\.config\opencode\bin\opencode-serve-attach.ps1`.
- Retire after live acceptance: `C:\Users\example\.config\opencode\plugins\opencode-restart\tui.mjs` and its `tui.jsonc` registration.
- Create: `D:\workspace\project\.reports\opencode-controller-tests\run-tests.ps1` — zero-dependency test runner.
- Create: `D:\workspace\project\.reports\opencode-controller-tests\fake-opencode-server.mjs` — configurable authenticated fake backend.
- Create: `D:\workspace\project\.reports\opencode-controller-tests\fake-opencode.cmd` — records CLI invocations instead of opening a TUI.

### Task 1: Build the isolated test harness

**Files:**
- Create: `D:\workspace\project\.reports\opencode-controller-tests\run-tests.ps1`
- Create: `D:\workspace\project\.reports\opencode-controller-tests\fake-opencode-server.mjs`
- Create: `D:\workspace\project\.reports\opencode-controller-tests\fake-opencode.cmd`

- [ ] **Step 1: Create the PowerShell assertion harness**

```powershell
$ErrorActionPreference = 'Stop'
$script:Failures = 0

function Assert-Equal($Actual, $Expected, [string]$Name) {
    if ($Actual -ne $Expected) {
        $script:Failures++
        Write-Error "$Name: expected '$Expected', got '$Actual'"
    } else { Write-Host "[PASS] $Name" }
}

function Assert-True([bool]$Condition, [string]$Name) {
    Assert-Equal $Condition $true $Name
}

function Complete-Tests {
    if ($script:Failures) { exit 1 }
    Write-Host '[PASS] all controller tests'
    exit 0
}
```

- [ ] **Step 2: Create a fake authenticated backend**

Implement a Node server that reads `FAKE_PORT`, `FAKE_USER`, `FAKE_PASSWORD`, and `FAKE_LOG`, returns `401` without matching Basic auth, returns `{"healthy":true,"version":"test-1"}` from `/global/health`, returns `{}` from `/config`, returns `{}` from `/session/status`, accepts `/session/:id/abort`, and writes every request to `FAKE_LOG` as JSONL.

```js
import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.env.FAKE_PORT);
const user = process.env.FAKE_USER || 'opencode';
const password = process.env.FAKE_PASSWORD || 'test-secret';
const expected = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const log = process.env.FAKE_LOG;

const server = http.createServer((req, res) => {
  fs.appendFileSync(log, JSON.stringify({ method: req.method, url: req.url }) + '\n');
  if (req.headers.authorization !== expected) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Secure Area"' });
    return res.end();
  }
  if (req.url.startsWith('/global/health')) return void res.end('{"healthy":true,"version":"test-1"}');
  if (req.url.startsWith('/config')) return void res.end('{}');
  if (req.url.startsWith('/session/status')) return void res.end('{}');
  if (/^\/session\/[^/]+\/abort/.test(req.url)) return void res.end('true');
  res.writeHead(404); res.end();
});

server.listen(port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
```

- [ ] **Step 3: Create a fake OpenCode CLI**

```batch
@echo off
echo %*>>"%FAKE_CLI_LOG%"
exit /b %FAKE_CLI_EXIT%
```

- [ ] **Step 4: Run the empty harness**

Run:

```powershell
pwsh -NoProfile -File "D:\workspace\project\.reports\opencode-controller-tests\run-tests.ps1"
```

Expected: `[PASS] all controller tests` and exit code `0`.

- [ ] **Step 5: Review checkpoint**

Inspect only the three new ignored test fixtures. Do not commit.

### Task 2: Implement canonical configuration and authenticated probes

**Files:**
- Create: `C:\Users\example\.config\opencode\bin\opencode-relay-common.psm1`
- Modify: `D:\workspace\project\.reports\opencode-controller-tests\run-tests.ps1`

- [ ] **Step 1: Write failing tests for User-scope rehydration and probes**

Do not mutate the real Windows User environment during tests. Pass an injected dictionary to `Get-RelayConfig -UserEnvironment` containing test username/password/port values while Process-scope values are absent, then assert the resulting config uses the injected User-scope values.

Also start the fake backend on port `4196` and assert:

```powershell
$anonymous = Invoke-WebRequest 'http://127.0.0.1:4196/global/health' -SkipHttpErrorCheck
Assert-Equal $anonymous.StatusCode 401 'anonymous health is unauthorized'

$probe = Invoke-RelayBackendProbe -Config $config
Assert-True $probe.Ready 'authenticated health and config are ready'
Assert-Equal $probe.Version 'test-1' 'probe reads server version'
```

- [ ] **Step 2: Run tests and verify failure**

Expected: import/function-not-found failure for `Get-RelayConfig` or `Invoke-RelayBackendProbe`.

- [ ] **Step 3: Implement the minimal configuration/probe API**

Export these functions:

```powershell
function Get-UserEnvironmentValue([string]$Name) {
    [Environment]::GetEnvironmentVariable($Name, 'User')
}

function Get-RelayConfig([hashtable]$UserEnvironment) {
    if (-not $UserEnvironment) {
        $UserEnvironment = @{}
        foreach ($name in 'OPENCODE_SERVER_PORT','OPENCODE_SERVER_USERNAME','OPENCODE_SERVER_PASSWORD','OPENCODE_TUNNEL_SCRIPT') {
            $UserEnvironment[$name] = Get-UserEnvironmentValue $name
        }
    }
    $port = $UserEnvironment.OPENCODE_SERVER_PORT
    if (-not $port) { $port = '4096' }
    $user = $UserEnvironment.OPENCODE_SERVER_USERNAME
    if (-not $user) { $user = 'opencode' }
    $password = $UserEnvironment.OPENCODE_SERVER_PASSWORD
    if (-not $password) { throw 'OPENCODE_SERVER_PASSWORD is not configured in User scope' }
    [pscustomobject]@{
        Host = '127.0.0.1'; Port = [int]$port; Username = $user; Password = $password
        RealOpenCode = $(if ($env:OPENCODE_REAL_CMD) { $env:OPENCODE_REAL_CMD } else { Join-Path $env:USERPROFILE 'AppData\Roaming\npm\opencode.cmd' })
        TunnelScript = $UserEnvironment.OPENCODE_TUNNEL_SCRIPT
        StateRoot = Join-Path $env:LOCALAPPDATA 'opencode-relay-server'
    }
}

function Get-BasicHeader($Config) {
    $raw = [Text.Encoding]::UTF8.GetBytes("$($Config.Username):$($Config.Password)")
    @{ Authorization = 'Basic ' + [Convert]::ToBase64String($raw) }
}

function Invoke-RelayBackendProbe($Config) {
    try {
        $headers = Get-BasicHeader $Config
        $health = Invoke-RestMethod "http://$($Config.Host):$($Config.Port)/global/health" -Headers $headers -TimeoutSec 3
        $null = Invoke-RestMethod "http://$($Config.Host):$($Config.Port)/config" -Headers $headers -TimeoutSec 3
        [pscustomobject]@{ Ready = ($health.healthy -eq $true); Version = $health.version; Error = $null }
    } catch {
        [pscustomobject]@{ Ready = $false; Version = $null; Error = $_.Exception.Message }
    }
}
```

Never print or serialize `Password`.

- [ ] **Step 4: Run tests and verify pass**

Expected: environment and authenticated probe tests pass; no secret appears in output or fake request log.

- [ ] **Step 5: Review checkpoint**

Read the module and test output. Do not commit.

### Task 3: Add state, mutex, listener ownership, and PID-reuse defense

**Files:**
- Modify: `C:\Users\example\.config\opencode\bin\opencode-relay-common.psm1`
- Modify: `D:\workspace\project\.reports\opencode-controller-tests\run-tests.ps1`

- [ ] **Step 1: Write failing state and identity tests**

Test atomic state round-trip, malformed state rejection, missing PID, wrong process creation time, wrong executable path, no listener, and a foreign listener on test port 4197. Assert foreign ownership is reported and never terminated.

- [ ] **Step 2: Run tests and verify failure**

Expected: missing `Use-RelayMutex`, `Read-RelayState`, `Write-RelayState`, `Get-RelayListener`, and `Test-ManagedBackendIdentity`.

- [ ] **Step 3: Implement state and ownership helpers**

State schema:

```json
{
  "schema": 1,
  "state": "READY",
  "generation": 3,
  "backend": {
    "pid": 68156,
    "createdUtc": "2026-07-09T11:05:04.0000000Z",
    "executable": "C:\\...\\opencode.exe",
    "port": 4096,
    "version": "1.17.14"
  }
}
```

Use `ConvertTo-Json`, write to `<state>.tmp`, flush/close, then `Move-Item -Force`. Use a named mutex such as `Local\OpenCodeRelayServer-<Windows SID>-<port>` with a bounded wait and `finally` release.

`Get-RelayListener` must use:

```powershell
Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort $Port
```

Identity passes only when there is exactly one listener and PID, creation timestamp, executable path, recorded port, and authenticated probe all agree.

- [ ] **Step 4: Run tests and verify pass**

Expected: malformed/stale/foreign states fail closed; the foreign fixture remains alive.

- [ ] **Step 5: Review checkpoint**

Confirm no process-control function accepts a PID without creation-time and executable validation. Do not commit.

### Task 4: Implement start, status, and doctor

**Files:**
- Create: `C:\Users\example\.config\opencode\bin\opencode-relay-server.ps1`
- Modify: `C:\Users\example\.config\opencode\bin\opencode-relay-common.psm1`
- Modify: test harness

- [ ] **Step 1: Write failing CLI contract tests**

Use test port 4196 and fake CLI/server dependencies. Assert:

- `status --json` emits one JSON object and performs no mutation;
- `doctor --json` reports Process/User credential state only as `SET|UNSET`, anonymous status, authenticated status, listener identity, and tunnel path;
- repeated `start` is idempotent;
- foreign listener returns a nonzero ownership-conflict code;
- readiness waits for authenticated health rather than accepting 401.

- [ ] **Step 2: Run tests and verify failure**

Expected: controller script missing or unsupported action.

- [ ] **Step 3: Implement thin command dispatch**

```powershell
param(
  [Parameter(Position=0)][ValidateSet('start','status','restart','stop','doctor')][string]$Action = 'status',
  [Parameter(Position=1)][ValidateSet('backend','tunnel')][string]$Target = 'backend',
  [switch]$Json
)
```

Move logic into module functions `Start-RelayBackend`, `Get-RelayStatus`, `Get-RelayDoctorReport`, and `Ensure-RelayTunnel`. The CLI serializes results only; it never contains process-ownership logic.

Start the backend with the canonical User-scope environment and absolute real CLI path, record the returned child PID/creation time, and wait until the recorded PID owns the listener and authenticated probes pass. Do not silently fallback inside `start`.

- [ ] **Step 4: Run tests and verify pass**

Expected: all start/status/doctor tests pass twice consecutively.

- [ ] **Step 5: Review checkpoint**

Inspect JSON output for secret leakage and verify no live port 4096 call occurred. Do not commit.

### Task 5: Implement managed attach leases and disruptive restart

**Files:**
- Modify: common module
- Modify: controller script
- Modify: test harness

- [ ] **Step 1: Write failing lease/restart tests**

Register two fake managed client processes and one unmanaged process. Assert restart:

- enters `RESTARTING`;
- refuses new lease creation;
- exits only verified managed clients;
- sends abort to session IDs observed from each lease directory's `/session/status`;
- waits the configured cleanup interval;
- stops only the verified backend;
- waits for process exit and port release;
- starts exactly one new generation;
- leaves tunnel and unmanaged process alive.

- [ ] **Step 2: Run tests and verify failure**

Expected: lease and restart functions missing.

- [ ] **Step 3: Implement leases and restart state machine**

Store one JSON lease per client under `<StateRoot>\clients\<pid>-<createdTicks>.json`. Validate every lease against the live process before use. Export:

```powershell
Register-RelayClientLease
Unregister-RelayClientLease
Get-VerifiedRelayClientLeases
Restart-RelayBackend
Stop-RelayBackend
Restart-RelayTunnel
Stop-RelayTunnel
```

Before terminating clients, publish `{"type":"tui.command.execute","properties":{"command":"app.exit"}}` through authenticated `POST /tui/publish?directory=<dir>` for each directory represented by verified leases. Then use `POST /session/<id>/abort` only for session IDs returned as active from those directories. Treat TUI exit and abort requests as best-effort, wait five seconds, and terminate only still-running verified managed process trees. Confirm no listener remains before starting the next generation.

- [ ] **Step 4: Run tests and verify pass**

Expected: generation advances once; unmanaged/tunnel fixtures remain; client registry is clean.

- [ ] **Step 5: Review checkpoint**

Verify the forceful semantics match the approved spec and every destructive action is guarded by explicit `restart`/`stop`. Do not commit.

### Task 6: Implement attach-or-local launch behavior

**Files:**
- Create: `C:\Users\example\.config\opencode\bin\opencode-launch.ps1`
- Modify: common module
- Modify: test harness

- [ ] **Step 1: Write failing launch tests**

With `OPENCODE_REAL_CMD` set to `fake-opencode.cmd`, assert:

1. Healthy preflight invokes `attach http://127.0.0.1:4196 --dir <cwd>`.
2. `-s ses_example`, `-c`, `--fork`, and `--mini` are forwarded unchanged.
3. Unhealthy preflight writes both approved warning lines to stdout and invokes the original local arguments without `attach`.
4. `--local` invokes the original CLI directly and performs no HTTP probe.
5. An attach exit code after healthy preflight is returned unchanged and never launches local fallback.

- [ ] **Step 2: Run tests and verify failure**

Expected: launch script missing.

- [ ] **Step 3: Implement launch process ownership**

Parse `--dir` without removing unrelated flags. Resolve the default directory with `(Get-Location).ProviderPath`. Run preflight once immediately before attach. Start attach as a child process with inherited console handles, register its PID lease, wait for exit, remove lease in `finally`, and return its exit code.

The fallback text must exactly be:

```text
[WARN] Relay backend at 127.0.0.1:4096 is unavailable.
[WARN] Starting local OpenCode. This session will not be visible through opencode.example.com.
```

- [ ] **Step 4: Run tests and verify pass**

Expected: fake CLI log contains one and only one invocation per case.

- [ ] **Step 5: Review checkpoint**

Confirm a normal attach exit cannot trigger fallback. Do not commit.

### Task 7: Build and test a staged batch dispatcher

**Files:**
- Create: `D:\workspace\project\.reports\opencode-controller-tests\staging\opencode.cmd`
- Test: test harness

- [ ] **Step 1: Add dispatcher characterization tests**

Run the wrapper with fake `OPENCODE_REAL_CMD` and test-only controller/launch script overrides. Cover:

```text
--relay_server start|status|restart|stop|doctor
--local
no args
--dir
-c / --continue
-s / --session
--fork
--mini
--usage
-u username
all other native subcommands
```

Assert `-u` no longer dispatches custom usage.

- [ ] **Step 2: Run characterization tests and verify the current wrapper fails new expectations**

Expected: `--relay_server` unsupported and `-u` incorrectly routes to usage.

- [ ] **Step 3: Implement minimal dispatch**

Copy the current production wrapper into the ignored staging directory. Keep dreaming and `--usage` dispatch. Remove custom `-u` usage handling. Add exact early dispatch for `--relay_server` and `--local`. Route only interactive argument forms to `opencode-launch.ps1`; pass all other commands to the real CLI unchanged. Parameterize script paths through test-only environment overrides so the production wrapper remains untouched.

- [ ] **Step 4: Run all controller tests**

Expected: all staged cases pass; the production wrapper and current listener PID on 4096 are unchanged.

- [ ] **Step 5: Review checkpoint**

Inspect the staged batch file for quoting and argument preservation. Do not commit.

### Task 7A: Replace the backend spawn primitive with a Tiny Node daemon launcher

**Files:**
- Create: `C:\Users\example\.config\opencode\bin\opencode-daemon-launcher.mjs`
- Modify: `C:\Users\example\.config\opencode\bin\opencode-relay-common.psm1`
- Modify: `D:\workspace\project\.reports\opencode-controller-tests\run-tests.ps1`
- Delete after replacement: `D:\workspace\project\.reports\opencode-controller-tests\pipe-eof-regression.ps1`

- [ ] **Step 1: Write the failing detached-launch contract tests**

Use the installed Node runtime and a disposable long-lived native child fixture. Assert that the launcher:

1. reads this envelope from stdin:

```json
{
  "executable": "C:\\absolute\\path\\to\\child.exe",
  "args": ["serve", "--hostname", "127.0.0.1", "--port", "4096"],
  "stdoutPath": "C:\\state\\backend.stdout.log",
  "stderrPath": "C:\\state\\backend.stderr.log"
}
```

2. calls Node `spawn()` with `detached: true`, `shell: false`, `windowsHide: true`, `stdio: ['ignore', stdoutFd, stderrFd]`, and the inherited credential environment;
3. emits exactly one JSON line `{ "pid": <direct-child-pid> }` after the `spawn` event;
4. closes its descriptor copies, calls `unref()`, reaches stdout/stderr EOF, and exits within two seconds while the child remains alive;
5. creates no persistent `cmd.exe` or PowerShell intermediary;
6. writes child output only to the configured log files;
7. returns a nonzero exit and no success handshake for malformed input or spawn failure.

- [ ] **Step 2: Run the focused test and verify RED**

Run the focused controller harness case while 4096 is free. Expected: FAIL because `opencode-daemon-launcher.mjs` is absent and the current PowerShell/cmd launch tree retains the caller lifecycle.

- [ ] **Step 3: Implement the minimal Node launcher**

Implement the launcher with Node standard-library modules only:

```javascript
import { openSync, closeSync } from 'node:fs'
import { spawn } from 'node:child_process'

const envelope = JSON.parse(await new Promise((resolve, reject) => {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => (input += chunk))
  process.stdin.on('end', () => resolve(input))
  process.stdin.on('error', reject)
}))

const out = openSync(envelope.stdoutPath, 'a')
const err = openSync(envelope.stderrPath, 'a')
const child = spawn(envelope.executable, envelope.args, {
  detached: true,
  shell: false,
  windowsHide: true,
  stdio: ['ignore', out, err],
  env: process.env,
})

child.once('spawn', () => {
  process.stdout.write(`${JSON.stringify({ pid: child.pid })}\n`)
  closeSync(out)
  closeSync(err)
  child.unref()
})
child.once('error', (error) => {
  closeSync(out)
  closeSync(err)
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
```

The final implementation must validate the envelope and guarantee descriptor closure once. It must never serialize the environment or credentials.

Update `Start-RelayBackendProduction` to resolve the native OpenCode executable, start the Node launcher as the short-lived `Launcher` process, write the envelope to stdin, close stdin, read one bounded handshake line, and wait for launcher exit/EOF. Return `OwnedPids` containing both the launcher PID and the direct child PID from the handshake; set `ExpectedExecutable` to the resolved child executable. This preserves the existing launch-attempt capture and cleanup contract when the launcher exits before readiness. Remove the experimental generated batch launcher and `start /b` logic completely.

- [ ] **Step 4: Run focused semantic acceptance**

Expected:

- the controller command returns and reaches EOF within its bounded readiness interval;
- the direct handshake PID becomes the sole 4096 listener;
- backend logs exist under `StateRoot`;
- no visible terminal window and no persistent shell intermediary exists;
- state PID, creation time, executable, listener PID, version, and authenticated health agree;
- verified stop removes the PID and releases 4096.

- [ ] **Step 5: Run the full controller harness twice**

Expected: both runs pass consecutively, all test-owned processes exit, and 4096 is free before Task 8.

### Task 8: Live-port semantic acceptance

**Files:**
- Modify only ignored test artifacts if failures require harness fixes.

- [ ] **Step 1: Confirm the authorized live port is free and run the full suite on 4096**

Run:

```powershell
$env:OPENCODE_SERVER_PORT='4096'
pwsh -NoProfile -File "D:\workspace\project\.reports\opencode-controller-tests\run-tests.ps1"
```

Expected: all tests pass and no process listens unexpectedly after cleanup. The user explicitly authorized termination of the obsolete 4096 listener for this construction round; do not use 4196/4197 as substitute implementation surfaces.

- [ ] **Step 2: Run the real managed OpenCode backend on 4096**

Use the canonical User-scope environment and real OpenCode binary. Verify authenticated health, two directory attaches, Ctrl+D detach without backend exit, session flag forwarding, and tunnel-only restart isolation. Keep the accepted backend running for Task 9 cutover rather than starting a parallel alternate-port service.

- [ ] **Step 3: Verify process ownership readback**

Compare state PID/start-time/executable with `Get-NetTCPConnection -State Listen -LocalPort 4096` and `Win32_Process`. Expected: one exact owner.

- [ ] **Step 4: Preserve acceptance logs**

Write redacted request/response/readback evidence under `.reports/opencode-controller-tests/results/`; never include passwords or Authorization headers.

- [ ] **Step 5: Review checkpoint**

Do not proceed to live cutover without explicit approval.

### Task 9: Live cutover and plugin retirement (permission-gated)

**Files:**
- Modify after approval: `C:\Users\example\.config\opencode\bin\opencode.cmd`
- Modify after successful cutover: `C:\Users\example\.config\opencode\tui.jsonc`
- Delete after successful cutover: `C:\Users\example\.config\opencode\plugins\opencode-restart\tui.mjs`
- Retire after successful cutover: `C:\Users\example\.config\opencode\bin\opencode-serve-attach.ps1`

- [ ] **Step 1: Request explicit lifecycle permission**

Surface the exact current backend PID, attached managed clients, active-session best-effort report, and expected disconnection. Wait for explicit approval to terminate the live backend.

- [ ] **Step 2: Install the tested dispatcher atomically**

Preserve a timestamped backup of the production wrapper under the ignored results directory, validate the staged dispatcher one last time with fake overrides, then atomically replace `C:\Users\example\.config\opencode\bin\opencode.cmd`. Verify `opencode --relay_server status` works before restarting the backend.

- [ ] **Step 3: Execute one controlled `--relay_server restart`**

Expected: managed TUIs exit, old verified PID exits, port releases, one new backend reaches authenticated health, tunnel remains running, generation advances once.

- [ ] **Step 4: Verify bare-command behavior from two directories**

Expected: each TUI receives the correct explicit `--dir`; `-s` resumes the intended session in its project; Ctrl+D detaches without changing backend generation.

- [ ] **Step 5: Remove the obsolete restart plugin registration and file**

Edit `tui.jsonc` to remove only `./plugins/opencode-restart/tui.mjs`. Delete the plugin file only after a fresh TUI confirms the command palette no longer contains the old restart action.

- [ ] **Step 6: Verify escape/fallback paths**

Use a test-only port override to demonstrate warning-plus-local fallback. Verify `opencode --local` bypasses the backend. Do not stop the production backend merely to test fallback.

- [ ] **Step 7: Preserve final evidence and stop**

Record redacted status, health, process identity, directory/session behavior, and plugin removal. Do not rotate credentials, deploy relay changes, or commit without separate authorization.

## Plan self-review

- Spec coverage: command surface, User-scope auth, identity verification, single port, attach/fallback, `--local`, `-s`, leases, disruptive restart, tunnel independence, plugin retirement, and permission-gated cutover all have tasks.
- Placeholder scan: no TBD/TODO/future implementation placeholders remain.
- Type consistency: module functions, state fields, generation, lease fields, and CLI actions are named consistently across tasks.
- Safety: every live destructive step is isolated in Task 9 behind explicit permission; Tasks 1-8 use fake or alternate-port substrate.
- Repository discipline: all test evidence stays ignored; no commit step is included because commits require explicit authorization.
