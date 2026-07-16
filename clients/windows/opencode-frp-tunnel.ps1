#Requires -Version 7
<#
.SYNOPSIS
    OpenCode FRP tunnel daemon (replaces SSH -R which is broken on Windows).
    Layer 1: SSH -L 17000:127.0.0.1:7000 → VPS frps  (control channel)
    Layer 2: frpc → localhost:17000                  (data channel through frp)

    Usage: opencode-frp-tunnel.ps1 start|stop|status

    Set OPENCODE_TUNNEL_HOST env var to override SSH alias (default: opencode-vps).
#>

param([ValidateSet('start','stop','status')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'

$SSH_ALIAS = if ($env:OPENCODE_TUNNEL_HOST) { $env:OPENCODE_TUNNEL_HOST } else { 'opencode-vps' }
$FRP_DIR    = "$PSScriptRoot\..\.run\frp"
$RUN_DIR    = "$PSScriptRoot\..\.run"
$PID_FILE   = "$RUN_DIR\frp-tunnel.pid"
$FRPC_EXE   = "$FRP_DIR\frpc.exe"
$FRPC_CFG   = "$FRP_DIR\frpc.toml"
if (-not (Test-Path $RUN_DIR)) { New-Item -ItemType Directory -Path $RUN_DIR -Force | Out-Null }

function Test-Running {
    if (-not (Test-Path $PID_FILE)) { return $false }
    try {
        $pids = (Get-Content $PID_FILE -Raw).Trim() -split ','
        foreach ($p in $pids) {
            $proc = Get-Process -Id ([int]$p) -ErrorAction Stop
            if ($proc.HasExited) { return $false }
        }
        return $true
    } catch { return $false }
}

function Start-Tunnel {
    if (Test-Running) { Write-Host "FRP tunnel already running (PIDs $(Get-Content $PID_FILE))"; return }

    # Kill any stale processes
    Get-Process -Name ssh,frpc -ErrorAction SilentlyContinue | Where-Object {
        $_.MainWindowTitle -eq '' -and ($_.CommandLine -match '17000|frpc')
    } | Stop-Process -Force -ErrorAction SilentlyContinue

    # Layer 1: SSH local forward
    $sshArgs = @('-o','ServerAliveInterval=30','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=10','-o','BatchMode=yes','-N','-L','17000:127.0.0.1:7000',$SSH_ALIAS)
    $ssh = Start-Process -FilePath 'ssh.exe' -ArgumentList $sshArgs -PassThru -WindowStyle Hidden
    Start-Sleep 2

    # Layer 2: frpc
    $frpc = Start-Process -FilePath $FRPC_EXE -ArgumentList '-c',$FRPC_CFG -PassThru -WindowStyle Hidden
    Start-Sleep 2

    "$($ssh.Id),$($frpc.Id)" | Out-File $PID_FILE -Encoding ascii -NoNewline
    Write-Host "FRP tunnel started: SSH PID=$($ssh.Id), frpc PID=$($frpc.Id)"
}

function Stop-Tunnel {
    if (-not (Test-Path $PID_FILE)) { Write-Host "Tunnel not running."; return }
    $pids = (Get-Content $PID_FILE -Raw).Trim() -split ','
    foreach ($p in $pids) { try { Stop-Process -Id ([int]$p) -Force -ErrorAction Stop } catch {} }
    Get-Process -Name ssh,frpc -ErrorAction SilentlyContinue | Where-Object {
        $_.Id -notin @($PID, (Get-Process -Id $PID).Id)
    } | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item $PID_FILE -ErrorAction SilentlyContinue
    Write-Host "FRP tunnel stopped."
}

function Show-Status {
    Write-Host "=== FRP Tunnel ==="
    if (Test-Running) { Write-Host "  Status: RUNNING (PIDs $(Get-Content $PID_FILE))" }
    else { Write-Host "  Status: STOPPED" }

    # Local OC
    try { $null = Invoke-RestMethod 'http://127.0.0.1:4096/global/health' -TimeoutSec 2; Write-Host "  Local OC : reachable" }
    catch { Write-Host "  Local OC : unreachable" }

    # VPS proxy through frp
    try {
        $code = ssh -o ConnectTimeout=5 -o BatchMode=yes $SSH_ALIAS "curl -sf -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:4096/global/health 2>/dev/null || echo '000'"
        if ($code -match '200|401') { Write-Host "  VPS proxy: reachable (HTTP $($code.Trim()))" }
        else { Write-Host "  VPS proxy: HTTP $($code.Trim())" }
    } catch { Write-Host "  VPS proxy: unreachable" }
}

switch ($Action) {
    'start'  { Start-Tunnel }
    'stop'   { Stop-Tunnel }
    'status' { Show-Status }
}
