#Requires -Version 7
<#
  opencode-serve-attach.ps1
  Handles the serve+attach flow for the opencode wrapper:
    1. Start the frp tunnel daemon (idempotent) if configured
    2. Start `opencode serve` on the fixed port if not already running
    3. Wait for the server to become healthy
    4. Attach the TUI (restart-aware loop)

  All the fragile logic lives here in PowerShell instead of batch, to avoid
  CMD parenthesis/quoting parse errors.

  Passes through any extra args (e.g. --dir, --continue) to `attach`.
#>

param([Parameter(ValueFromRemainingArguments = $true)][string[]]$PassThroughArgs)

$ErrorActionPreference = 'Continue'

# -- Resolve real opencode binary --
$RealOpencode = $env:OPENCODE_REAL_CMD
if (-not $RealOpencode) { $RealOpencode = Join-Path $env:USERPROFILE 'AppData\Roaming\npm\opencode.cmd' }
if (-not (Test-Path $RealOpencode)) {
    Write-Error "[FAIL] OpenCode launcher not found at $RealOpencode"
    exit 1
}

# -- Fixed port --
$Port = $env:OPENCODE_SERVER_PORT
if (-not $Port) { $Port = '4096' }

$RestartSignal = Join-Path $env:USERPROFILE '.opencode\.restart-requested'

function Test-ServerHealthy {
    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:$Port/global/health" -TimeoutSec 3 -UseBasicParsing | Out-Null
        return $true
    } catch {
        # 401 = server up but needs auth = healthy for our purposes
        if ($_.Exception.Response.StatusCode.value__ -eq 401) { return $true }
        return $false
    }
}

function Test-PortListening {
    return (Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -WarningAction SilentlyContinue).TcpTestSucceeded
}

function Start-Serve {
    Write-Host "[opencode] Starting server on port $Port..." -ForegroundColor Cyan
    Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' -ArgumentList '/c', $RealOpencode, 'serve', '--port', $Port | Out-Null
    Write-Host "[opencode] Waiting for server..." -ForegroundColor Cyan
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-ServerHealthy) { return $true }
    }
    return $false
}

# ============================================================
# Phase 0: Start tunnel daemon (idempotent)
# ============================================================
if ($env:OPENCODE_TUNNEL_SCRIPT -and (Test-Path $env:OPENCODE_TUNNEL_SCRIPT)) {
    Write-Host "[opencode] Starting tunnel daemon..." -ForegroundColor DarkGray
    & pwsh -NoProfile -NoLogo -File $env:OPENCODE_TUNNEL_SCRIPT start *> $null
}

# ============================================================
# Phase 1: Ensure server is running
# ============================================================
if (-not (Test-PortListening)) {
    if (-not (Start-Serve)) {
        Write-Warning "[opencode] server not ready on port $Port, falling through to direct launch"
        & $RealOpencode @PassThroughArgs
        exit $LASTEXITCODE
    }
}

# ============================================================
# Phase 2: Attach TUI (restart-aware loop)
# ============================================================
if (Test-Path $RestartSignal) { Remove-Item $RestartSignal -Force -ErrorAction SilentlyContinue }

while ($true) {
    & $RealOpencode attach "http://localhost:$Port" @PassThroughArgs
    $attachExit = $LASTEXITCODE

    if (-not (Test-Path $RestartSignal)) {
        exit $attachExit
    }

    # Restart requested
    Remove-Item $RestartSignal -Force -ErrorAction SilentlyContinue
    Write-Host "[opencode] Restart signal detected. Restarting server..." -ForegroundColor Yellow

    # Kill serve process
    $conn = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
    if ($conn) { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2

    # Restart serve
    if (-not (Start-Serve)) {
        Write-Error "[opencode] server failed to restart"
        exit 1
    }
    Write-Host "[opencode] Server restarted. Re-attaching..." -ForegroundColor Green
}
