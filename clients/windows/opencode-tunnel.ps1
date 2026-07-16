#Requires -Version 7
<#
.SYNOPSIS
    OpenCode SSH reverse tunnel daemon — connects local OpenCode server
    to VPS so mobile/remote clients can reach it via opencode.example.com.

.DESCRIPTION
    Maintains a persistent SSH reverse tunnel:
        localhost:LOCAL_PORT  <-->  VPS:REMOTE_PORT
    via `ssh -N -R REMOTE_PORT:localhost:LOCAL_PORT $SSH_ALIAS`.

    If autossh is installed, uses it for automatic restart and hung-connection
    detection. Otherwise falls back to a plain PowerShell retry loop.

.PARAMETER Action
    start   — Launch the tunnel daemon (background)
    stop    — Kill the running tunnel daemon
    status  — Show tunnel health and connection state
    logs    — Tail recent tunnel log entries
    install — Register as a Windows Scheduled Task (run at logon)
    uninstall — Remove the Scheduled Task

.EXAMPLE
    .\opencode-tunnel.ps1 start
    .\opencode-tunnel.ps1 status
    .\opencode-tunnel.ps1 install
#>

param(
    [ValidateSet('start','stop','status','logs','install','uninstall')]
    [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

# ── Configuration ──────────────────────────────────────────────
$LOCAL_PORT  = if ($env:OPENCODE_SERVER_PORT) { $env:OPENCODE_SERVER_PORT } else { '4096' }
$REMOTE_PORT = $LOCAL_PORT  # Same port on VPS side
$SSH_ALIAS   = if ($env:OPENCODE_TUNNEL_HOST) { $env:OPENCODE_TUNNEL_HOST } else { 'opencode-vps' }
$RUN_DIR     = "$PSScriptRoot\..\.run"
$PID_FILE    = "$RUN_DIR\tunnel.pid"
$LOG_FILE    = "$RUN_DIR\tunnel.log"
$TASK_NAME   = 'OpenCode-Tunnel'

# ── Ensure run dir exists ──────────────────────────────────────
if (-not (Test-Path $RUN_DIR)) {
    New-Item -ItemType Directory -Path $RUN_DIR -Force | Out-Null
}

# ── Helpers ────────────────────────────────────────────────────
function Test-TunnelRunning {
    if (-not (Test-Path $PID_FILE)) { return $false }
    try {
        $pid = [int](Get-Content $PID_FILE -Raw).Trim()
        $proc = Get-Process -Id $pid -ErrorAction Stop
        return -not $proc.HasExited
    } catch { return $false }
}

function Write-Log {
    param([string]$Message)
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
    "$ts  $Message" | Out-File -Append -LiteralPath $LOG_FILE -Encoding utf8
}

function Get-AutosshPath {
    $paths = @(
        (Get-Command autossh -ErrorAction SilentlyContinue).Source,
        'C:\Program Files\Git\usr\bin\autossh.exe',
        "$env:ProgramFiles\autossh\autossh.exe",
        "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\*\autossh.exe"
    )
    foreach ($p in $paths) {
        if ($p -and (Test-Path $p)) { return $p }
    }
    return $null
}

# ── Check remote port reachability ─────────────────────────────
function Test-RemotePortOpen {
    # Requires port-forwarding to already be active.
    # Uses SSH to check from the VPS side.
    try {
        $result = ssh -o ConnectTimeout=5 -o BatchMode=yes $SSH_ALIAS "ss -tlnp | grep -q ':${REMOTE_PORT}\b'" 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch { return $false }
}

# ═══════════════════════════════════════════════════════════════
#  STATUS
# ═══════════════════════════════════════════════════════════════
function Show-Status {
    Write-Host "=== OpenCode Tunnel Status ===" -ForegroundColor Cyan
    Write-Host "  Local port : $LOCAL_PORT"
    Write-Host "  Remote port: $REMOTE_PORT"
    Write-Host "  SSH alias  : $SSH_ALIAS"
    Write-Host "  Run dir    : $RUN_DIR"

    $autosshPath = Get-AutosshPath
    if ($autosshPath) {
        Write-Host "  autossh    : $autosshPath" -ForegroundColor Green
    } else {
        Write-Host "  autossh    : not found (fallback: ssh retry loop)" -ForegroundColor Yellow
    }

    if (Test-TunnelRunning) {
        $pid = Get-Content $PID_FILE -Raw
        Write-Host "  Daemon PID : $pid" -ForegroundColor Green
    } else {
        Write-Host "  Daemon PID : not running" -ForegroundColor Red
    }

    # Check local OpenCode server
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:${LOCAL_PORT}/global/health" -TimeoutSec 3
        Write-Host "  Local OC   : healthy (v$($health.version))" -ForegroundColor Green
    } catch {
        Write-Host "  Local OC   : UNREACHABLE" -ForegroundColor Red
    }

    # Check remote port (via SSH)
    if (Test-RemotePortOpen) {
        Write-Host "  VPS port   : listening on :$REMOTE_PORT" -ForegroundColor Green
    } else {
        Write-Host "  VPS port   : NOT listening (tunnel may be down)" -ForegroundColor Yellow
    }

    # Last log lines
    if (Test-Path $LOG_FILE) {
        $lastLines = Get-Content $LOG_FILE -Tail 5
        Write-Host "`n  Recent log:"
        foreach ($line in $lastLines) {
            Write-Host "    $line" -ForegroundColor DarkGray
        }
    }
}

# ═══════════════════════════════════════════════════════════════
#  START
# ═══════════════════════════════════════════════════════════════
function Start-Tunnel {
    if (Test-TunnelRunning) {
        Write-Host "Tunnel daemon already running (PID $(Get-Content $PID_FILE))" -ForegroundColor Yellow
        Show-Status
        return
    }

    Write-Log "=== STARTING TUNNEL ==="
    Write-Log "SSH=$SSH_ALIAS localhost:$LOCAL_PORT -> VPS:$REMOTE_PORT"

    $autosshPath = Get-AutosshPath

    # Build the background script block
    if ($autosshPath) {
        # autossh: monitors connection via a separate check port, auto-restarts on failure
        $MONITOR_PORT = [int]$LOCAL_PORT + 1
        $scriptBlock = {
            param($autossh, $sshAlias, $localPort, $remotePort, $monitorPort, $logFile)
            & $autossh `
                -M $monitorPort `
                -o "ServerAliveInterval=30" `
                -o "ServerAliveCountMax=3" `
                -o "ExitOnForwardFailure=yes" `
                -o "ConnectTimeout=10" `
                -o "BatchMode=yes" `
                -N -R "${remotePort}:localhost:${localPort}" $sshAlias `
                2>&1 | Out-File -Append -LiteralPath $logFile -Encoding utf8
        }
    } else {
        # Fallback: plain SSH with retry loop
        $scriptBlock = {
            param($sshAlias, $localPort, $remotePort, $logFile)
            while ($true) {
                $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
                "$ts  Connecting $sshAlias -R ${remotePort}:localhost:${localPort}..." | Out-File -Append -LiteralPath $logFile -Encoding utf8
                ssh -o "ServerAliveInterval=30" `
                    -o "ServerAliveCountMax=3" `
                    -o "ExitOnForwardFailure=yes" `
                    -o "ConnectTimeout=10" `
                    -o "BatchMode=yes" `
                    -N -R "${remotePort}:localhost:${localPort}" $sshAlias `
                    2>&1 | Out-File -Append -LiteralPath $logFile -Encoding utf8
                $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
                "$ts  SSH exited (code=$LASTEXITCODE). Retrying in 5s..." | Out-File -Append -LiteralPath $logFile -Encoding utf8
                Start-Sleep -Seconds 5
            }
        }
    }

    # Launch in background
    $pwshPath = (Get-Process -Id $PID).Path
    if (-not $pwshPath) { $pwshPath = 'pwsh.exe' }

    $args = @(
        '-NoProfile', '-NoLogo', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-Command', "& { $scriptBlock }"
    )
    $proc = Start-Process -FilePath $pwshPath -ArgumentList $args -PassThru -WindowStyle Hidden

    $proc.Id | Out-File -LiteralPath $PID_FILE -Encoding ascii -NoNewline
    Write-Log "Daemon started (PID=$($proc.Id), autossh=$($autosshPath -ne $null))"
    Write-Host "Tunnel daemon started (PID=$($proc.Id))" -ForegroundColor Green
    Write-Host "  localhost:$LOCAL_PORT <--> $SSH_ALIAS`:$REMOTE_PORT" -ForegroundColor Cyan

    Start-Sleep -Seconds 2
    if (Test-RemotePortOpen) {
        Write-Host "  VPS port :$REMOTE_PORT confirmed listening" -ForegroundColor Green
    } else {
        Write-Host "  VPS port :$REMOTE_PORT not yet confirmed (may need a moment)" -ForegroundColor Yellow
    }
}

# ═══════════════════════════════════════════════════════════════
#  STOP
# ═══════════════════════════════════════════════════════════════
function Stop-Tunnel {
    if (-not (Test-TunnelRunning)) {
        Write-Host "Tunnel daemon not running." -ForegroundColor Yellow
        return
    }

    $pid = [int](Get-Content $PID_FILE -Raw).Trim()
    Write-Log "Stopping daemon (PID=$pid)..."

    # Kill the pwsh wrapper first, then any child ssh processes
    try { Stop-Process -Id $pid -Force -ErrorAction Stop } catch {}
    Start-Sleep -Seconds 1

    # Clean up any orphaned ssh/autossh
    Get-Process -Name ssh,autossh -ErrorAction SilentlyContinue | Stop-Process -Force

    Remove-Item $PID_FILE -ErrorAction SilentlyContinue
    Write-Log "Daemon stopped."
    Write-Host "Tunnel daemon stopped." -ForegroundColor Green
}

# ═══════════════════════════════════════════════════════════════
#  LOGS
# ═══════════════════════════════════════════════════════════════
function Show-Logs {
    param([int]$Tail = 40)
    if (Test-Path $LOG_FILE) {
        Get-Content $LOG_FILE -Tail $Tail
    } else {
        Write-Host "No log file at $LOG_FILE" -ForegroundColor Yellow
    }
}

# ═══════════════════════════════════════════════════════════════
#  INSTALL / UNINSTALL (Scheduled Task)
# ═══════════════════════════════════════════════════════════════
function Install-ScheduledTask {
    $scriptPath = $PSCommandPath
    $action = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument "-NoProfile -NoLogo -File `"$scriptPath`" start"
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

    Register-ScheduledTask -TaskName $TASK_NAME -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
    Write-Host "Scheduled Task '$TASK_NAME' installed — tunnel will auto-start at logon." -ForegroundColor Green
}

function Uninstall-ScheduledTask {
    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Scheduled Task '$TASK_NAME' removed." -ForegroundColor Green
}

# ═══════════════════════════════════════════════════════════════
#  DISPATCH
# ═══════════════════════════════════════════════════════════════
switch ($Action) {
    'status'    { Show-Status }
    'start'     { Start-Tunnel }
    'stop'      { Stop-Tunnel }
    'logs'      { Show-Logs }
    'install'   { Install-ScheduledTask }
    'uninstall' { Uninstall-ScheduledTask }
}
