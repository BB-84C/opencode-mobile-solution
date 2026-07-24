#Requires -Version 7.2

# Resident tunnel supervisor for the Windows relay controller.
#
# The managed tunnel (SSH local forward + FRPC) is launched detached and
# unsupervised. A transient network drop (VPN / stateful firewall / NAT that
# tears down long-lived TCP) makes ssh.exe exit by its own ServerAliveCountMax
# design, and nothing re-establishes it -> the tunnel stays Degraded forever.
#
# This process is a resident watchdog that re-converges ONLY the tunnel after
# such a drop. It reuses the controller's own ownership-safe converge path
# (Start-RelayManagedTunnel) under the SAME cross-process named mutex, so it can
# never race a user start/stop/restart. It never touches the local backend and
# never kills a process it does not own. It exits promptly on the stop sentinel.
#
# It is configured entirely from the environment its launcher (Start-RelaySupervisor)
# provides, so this file carries no deployment-specific values.

Import-Module (Join-Path $PSScriptRoot 'opencode-relay-common.psm1') -Force -ErrorAction Stop -DisableNameChecking -WarningAction SilentlyContinue
Import-Module (Join-Path $PSScriptRoot 'opencode-relay-machine.psm1') -Force -ErrorAction Stop -DisableNameChecking -WarningAction SilentlyContinue

# Read the process-scope environment the launcher injected (port, credentials,
# relay origin, ssh alias, frpc path, config dir, interval). The controller
# resolves these values and passes them down, so reading process scope guarantees
# the supervisor derives the SAME config as the controller -- crucially the SAME
# port, hence the SAME named mutex. Get-RelayConfig / Get-RelayMachineConfig read
# USER (registry) scope when handed no environment, which would ignore this
# injection and could silently split the mutex.
$processEnvironment = @{}
foreach ($name in @('OPENCODE_SERVER_PORT', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_RELAY_ORIGIN', 'OPENCODE_RELAY_SSH_ALIAS', 'OPENCODE_FRPC_EXE', 'OPENCODE_RELAY_CONFIG_DIR', 'OPENCODE_RELAY_SUPERVISOR_INTERVAL_MS')) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ($null -ne $value) { $processEnvironment[$name] = $value }
}
$config = Get-RelayConfig -UserEnvironment $processEnvironment
$machineConfig = Get-RelayMachineConfig -Config $config -UserEnvironment $processEnvironment

$intervalMs = [int]$machineConfig.SupervisorIntervalMs
if ($intervalMs -lt 10000) { $intervalMs = 10000 }
$stopSentinel = [string]$machineConfig.SupervisorStopSentinelPath
$statusPath = [string]$machineConfig.SupervisorStatusPath
# Short, so a running user command (which holds the mutex) is never fought; the
# supervisor simply backs off and retries on the next tick.
$mutexHealTimeoutMs = 3000

function Write-RelaySupervisorStatus {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$State,
        [string]$TunnelStatus = 'unknown',
        [string]$LastError = $null,
        [string]$LastHealAt = $null
    )
    try {
        [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
        $value = [PSCustomObject]@{
            schema = 1
            state = $State
            lastTunnelStatus = $TunnelStatus
            lastHealAt = $LastHealAt
            lastError = $LastError
            intervalMs = $intervalMs
            pid = $PID
            updatedAt = [datetime]::UtcNow.ToString('o')
        }
        $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N').Substring(0, 8)).tmp"
        [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Compress))
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    catch {
        # Status telemetry is best-effort and must never crash the loop.
    }
}

function Test-RelaySupervisorStopRequested {
    param([Parameter(Mandatory)][string]$Path)
    return (Test-Path -LiteralPath $Path -PathType Leaf)
}

$lastHealAt = $null
Write-RelaySupervisorStatus -Path $statusPath -State 'Running' -TunnelStatus 'startup' -LastHealAt $lastHealAt

while ($true) {
    if (Test-RelaySupervisorStopRequested -Path $stopSentinel) { break }

    try {
        $tunnelStatus = 'unknown'
        try {
            $tunnel = Get-RelayManagedTunnelStatus -MachineConfig $machineConfig -ProcessProvider $null
            $tunnelStatus = [string]$tunnel.Status
        }
        catch {
            Write-RelaySupervisorStatus -Path $statusPath -State 'Running' -TunnelStatus 'error' -LastError ("status: " + [string]$_.Exception.Message) -LastHealAt $lastHealAt
            $tunnelStatus = 'error'
        }

        if ($tunnelStatus -eq 'Degraded' -or $tunnelStatus -eq 'Stopped') {
            try {
                # Heal under the shared mutex so a user start/stop/restart is never
                # raced. If the mutex is held (a user command is running) the
                # acquisition times out; we swallow it and retry on the next tick.
                $healed = Use-RelayMutex -Config $config -TimeoutMs $mutexHealTimeoutMs -ScriptBlock {
                    # A stop requested while we waited for the mutex wins: do not heal.
                    if (Test-Path -LiteralPath $stopSentinel -PathType Leaf) { return $false }
                    $recheck = Get-RelayManagedTunnelStatus -MachineConfig $machineConfig -ProcessProvider $null
                    if ([string]$recheck.Status -eq 'Running') { return $false }
                    $null = Start-RelayManagedTunnel -Config $config -MachineConfig $machineConfig -ProcessProvider $null -DaemonProvider $null -SleepProvider $null
                    return $true
                }
                if ($healed) { $lastHealAt = [datetime]::UtcNow.ToString('o') }
                $post = Get-RelayManagedTunnelStatus -MachineConfig $machineConfig -ProcessProvider $null
                Write-RelaySupervisorStatus -Path $statusPath -State 'Running' -TunnelStatus ([string]$post.Status) -LastHealAt $lastHealAt
            }
            catch {
                Write-RelaySupervisorStatus -Path $statusPath -State 'Running' -TunnelStatus $tunnelStatus -LastError ("heal: " + [string]$_.Exception.Message) -LastHealAt $lastHealAt
            }
        }
        else {
            Write-RelaySupervisorStatus -Path $statusPath -State 'Running' -TunnelStatus $tunnelStatus -LastHealAt $lastHealAt
        }
    }
    catch {
        # A resident supervisor that crashes defeats its purpose: log and keep looping.
        Write-RelaySupervisorStatus -Path $statusPath -State 'Running' -TunnelStatus 'error' -LastError ("loop: " + [string]$_.Exception.Message) -LastHealAt $lastHealAt
    }

    # Sleep to the next tick in small slices so the stop sentinel is honored promptly.
    $remainingMs = $intervalMs
    while ($remainingMs -gt 0) {
        if (Test-RelaySupervisorStopRequested -Path $stopSentinel) { break }
        $sliceMs = [Math]::Min(1000, $remainingMs)
        Start-Sleep -Milliseconds $sliceMs
        $remainingMs -= $sliceMs
    }
    if (Test-RelaySupervisorStopRequested -Path $stopSentinel) { break }
}

Write-RelaySupervisorStatus -Path $statusPath -State 'Stopped' -TunnelStatus 'n/a' -LastHealAt $lastHealAt
# Best-effort cleanup so the next Start-RelaySupervisor is not tripped by our sentinel.
try { Remove-Item -LiteralPath $stopSentinel -Force -ErrorAction SilentlyContinue } catch { }
