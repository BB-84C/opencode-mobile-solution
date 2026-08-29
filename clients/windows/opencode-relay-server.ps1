#Requires -Version 7.2
[CmdletBinding()]
param(
    [ValidateSet('start', 'status', 'restart', 'stop', 'doctor')]
    [string]$Action = 'status',
    # relay (default) manages the whole product: authorization, backend, tunnel,
    # heartbeat agent. backend is the internal launcher target and never waits for
    # browser authorization. tunnel manages the VPS connection plus the agent.
    [ValidateSet('relay', 'backend', 'tunnel')]
    [string]$Target = 'relay',
    [switch]$Json,
    [Parameter(DontShow)]
    [hashtable]$UserEnvironment,
    [Parameter(DontShow)]
    [psobject]$ConfigOverride,
    [Parameter(DontShow)]
    [psobject]$MachineConfigOverride,
    [Parameter(DontShow)]
    [hashtable]$Providers,
    [Parameter(DontShow)]
    [ValidateRange(1, 60000)]
    [int]$LifecycleTimeoutMs = 20000,
    [Parameter(DontShow)]
    [ValidateRange(10000, 180000)]
    [int]$TunnelConvergenceTimeoutMs = 90000,
    [Parameter(DontShow)]
    [ValidateRange(1, 10000)]
    [int]$LifecyclePollMs = 200
)

$ErrorActionPreference = 'Stop'

$modulePath = Join-Path $PSScriptRoot 'opencode-relay-common.psm1'
Import-Module -Name $modulePath -Force -ErrorAction Stop -DisableNameChecking -WarningAction SilentlyContinue
Import-Module -Name (Join-Path $PSScriptRoot 'opencode-relay-machine.psm1') -Force -ErrorAction Stop -DisableNameChecking -WarningAction SilentlyContinue

function Get-RelayExitCode {
    param(
        [Parameter(Mandatory)][string]$Message
    )

    if ($Message -match 'ownership conflict|requires restart|stale') { return 6 }
    if ($Message -match 'unhealthy|start failed|stop failed|replacement|degraded|deadline') { return 7 }
    return 10
}

function Get-RelaySafeErrorDetail {
    param([Parameter(Mandatory)][string]$Message)
    if ($Message -match 'deadline') { return 'Relay lifecycle deadline expired.' }
    if ($Message -match 'ownership conflict') { return 'Relay ownership conflict.' }
    if ($Message -match 'replacement') { return 'Replacement backend failed to become healthy.' }
    if ($Message -match 'start failed') { return 'Relay backend start failed.' }
    return 'Relay command failed.'
}

function Write-RelayResult {
    param(
        [Parameter(Mandatory)]$Result,
        [Parameter(Mandatory)][int]$ExitCode
    )

    if ($Json) {
        # The JSON mode contract is one compact object on stdout and no diagnostics there.
        Write-Output ($Result | ConvertTo-Json -Depth 8 -Compress)
    }
    else {
        # Human mode renders the SAME data the JSON mode carries: every field, nested
        # objects indented, nothing collapsed. Values are already secret-free by
        # contract (credentials appear only as SET/UNSET).
        function Format-RelayHumanLines {
            param($Value, [string]$Name = '', [int]$Indent = 0)
            $pad = ' ' * $Indent
            if ($null -eq $Value) { if ($Name) { Write-Output "$pad${Name}:" }; return }
            if ($Value -is [System.Collections.IDictionary] -or $Value -is [psobject] -and $Value.PSObject.Properties.Name.Count -gt 0 -and -not ($Value -is [string]) -and -not ($Value -is [ValueType])) {
                $props = if ($Value -is [System.Collections.IDictionary]) { $Value.Keys } else { $Value.PSObject.Properties.Name }
                if (@($props).Count -gt 0 -and -not ($Value -is [string])) {
                    if ($Name) { Write-Output "$pad${Name}:" }
                    foreach ($prop in $props) {
                        $child = if ($Value -is [System.Collections.IDictionary]) { $Value[$prop] } else { $Value.$prop }
                        if ($child -is [array]) {
                            if (@($child).Count -eq 0) { continue }
                            Write-Output "$pad  ${prop}:"
                            foreach ($item in $child) { Write-Output "$pad  - $item" }
                        }
                        elseif ($null -ne $child -and -not ($child -is [string]) -and -not ($child -is [ValueType]) -and $child.PSObject.Properties.Name.Count -gt 0) {
                            Format-RelayHumanLines -Value $child -Name $prop -Indent ($Indent + 2)
                        }
                        else {
                            Write-Output "$pad  ${prop}: $child"
                        }
                    }
                    return
                }
            }
            if ($Name) { Write-Output "$pad${Name}: $Value" } else { Write-Output "$pad$Value" }
        }
        foreach ($topName in $Result.PSObject.Properties.Name) {
            $topValue = $Result.$topName
            if ($topName -eq 'Warnings') {
                if (@($topValue).Count -gt 0) {
                    Write-Output 'Warnings:'
                    foreach ($warning in @($topValue)) { Write-Output "- $warning" }
                }
                continue
            }
            if ($null -ne $topValue -and -not ($topValue -is [string]) -and -not ($topValue -is [ValueType]) -and $topValue.PSObject.Properties.Name.Count -gt 0) {
                Format-RelayHumanLines -Value $topValue -Name $topName -Indent 0
            }
            elseif ($topValue -is [array]) {
                if (@($topValue).Count -gt 0) {
                    Write-Output "${topName}:"
                    foreach ($item in @($topValue)) { Write-Output "- $item" }
                }
            }
            else {
                Write-Output "${topName}: $topValue"
            }
        }
    }
    exit $ExitCode
}

try {
    $config = if ($null -ne $ConfigOverride) { $ConfigOverride } else { Get-RelayConfig -UserEnvironment $UserEnvironment }
    if ($null -eq $Providers) { $Providers = @{} }

    if ($Target -eq 'backend') {
        # Internal launcher target: local 4096 backend only, never OAuth, never the
        # browser. Behavior and exit codes are unchanged from the pre-OAuth core.
        switch ($Action) {
            'start' {
                $result = Start-RelayBackend -Config $config -StartBackendProvider $Providers.StartBackendProvider -ListenerProvider $Providers.ListenerProvider -ProcessProvider $Providers.ProcessProvider -ProbeProvider $Providers.ProbeProvider -ReadyTimeoutMs $LifecycleTimeoutMs -PollMs $LifecyclePollMs
                Write-RelayResult -Result $result -ExitCode 0
            }
            'status' {
                $result = Get-RelayStatus -Config $config -ListenerProvider $Providers.ListenerProvider -ProcessProvider $Providers.ProcessProvider -ProbeProvider $Providers.ProbeProvider
                $exitCode = switch ($result.State) {
                    'Ready' { 0 }
                    'Stopped' { 3 }
                    'Foreign' { 6 }
                    'Conflict' { 6 }
                    'Stale' { 6 }
                    'Unhealthy' { 7 }
                    'DEGRADED' { 7 }
                    default { 10 }
                }
                Write-RelayResult -Result $result -ExitCode $exitCode
            }
            'doctor' {
                $result = Get-RelayDoctorReport -Config $config -UserEnvironment $UserEnvironment
                Write-RelayResult -Result $result -ExitCode 0
            }
            'restart' {
                $result = Restart-RelayBackend -Config $config -TuiExitProvider $Providers.TuiExitProvider -ActiveSessionProvider $Providers.ActiveSessionProvider -AbortSessionProvider $Providers.AbortSessionProvider -StopProcessTreeProvider $Providers.StopProcessTreeProvider -StartBackendProvider $Providers.StartBackendProvider -SleepProvider $Providers.SleepProvider -ListenerProvider $Providers.ListenerProvider -ProcessProvider $Providers.ProcessProvider -ProbeProvider $Providers.ProbeProvider -PortFreeProvider $Providers.PortFreeProvider -LifecycleTimeoutMs $LifecycleTimeoutMs -PollMs $LifecyclePollMs -NowProvider $Providers.NowProvider
                Write-RelayResult -Result $result -ExitCode 0
            }
            'stop' {
                $result = Stop-RelayBackend -Config $config -TuiExitProvider $Providers.TuiExitProvider -ActiveSessionProvider $Providers.ActiveSessionProvider -AbortSessionProvider $Providers.AbortSessionProvider -StopProcessTreeProvider $Providers.StopProcessTreeProvider -SleepProvider $Providers.SleepProvider -ListenerProvider $Providers.ListenerProvider -ProcessProvider $Providers.ProcessProvider -ProbeProvider $Providers.ProbeProvider -PortFreeProvider $Providers.PortFreeProvider -LifecycleTimeoutMs $LifecycleTimeoutMs -PollMs $LifecyclePollMs -NowProvider $Providers.NowProvider
                Write-RelayResult -Result $result -ExitCode 0
            }
        }
    }
    else {
        # Full-relay and tunnel mutations span client shutdown (fixed 5 s grace),
        # backend replacement boot, tunnel, and agent phases on one shared deadline;
        # the 20 s backend-target default is too tight for that composite unless the
        # caller overrode it explicitly.
        if (-not $PSBoundParameters.ContainsKey('LifecycleTimeoutMs')) { $LifecycleTimeoutMs = 45000 }
        $machineConfig = if ($null -ne $MachineConfigOverride) { $MachineConfigOverride } else { Get-RelayMachineConfig -Config $config }
        if ($Target -eq 'tunnel') {
            $outcome = Invoke-RelayTunnelTarget -Config $config -MachineConfig $machineConfig -Action $Action -Providers $Providers -LifecycleTimeoutMs $LifecycleTimeoutMs -TunnelConvergenceTimeoutMs $TunnelConvergenceTimeoutMs
            Write-RelayResult -Result $outcome.Result -ExitCode $outcome.ExitCode
        }
        else {
            $outcome = switch ($Action) {
                'status' { Invoke-RelayOrchestratedStatus -Config $config -MachineConfig $machineConfig -Providers $Providers }
                'doctor' { Invoke-RelayOrchestratedDoctor -Config $config -MachineConfig $machineConfig -Providers $Providers -UserEnvironment $UserEnvironment }
                'start' { Invoke-RelayOrchestratedStart -Config $config -MachineConfig $machineConfig -Providers $Providers -LifecycleTimeoutMs $LifecycleTimeoutMs -TunnelConvergenceTimeoutMs $TunnelConvergenceTimeoutMs -PollMs $LifecyclePollMs }
                'restart' { Invoke-RelayOrchestratedRestart -Config $config -MachineConfig $machineConfig -Providers $Providers -LifecycleTimeoutMs $LifecycleTimeoutMs -TunnelConvergenceTimeoutMs $TunnelConvergenceTimeoutMs -PollMs $LifecyclePollMs }
                'stop' { Invoke-RelayOrchestratedStop -Config $config -MachineConfig $machineConfig -Providers $Providers -LifecycleTimeoutMs $LifecycleTimeoutMs -PollMs $LifecyclePollMs }
            }
            Write-RelayResult -Result $outcome.Result -ExitCode $outcome.ExitCode
        }
    }
}
catch {
    $message = [string]$_.Exception.Message
    $exitCode = Get-RelayExitCode -Message $message
    if ($Json) {
        $safeError = Get-RelaySafeErrorDetail -Message $message
        Write-Output ([PSCustomObject]@{ State = 'Error'; Error = $safeError; Warnings = @($safeError) } | ConvertTo-Json -Compress)
    }
    else {
        Write-Error -Message $message -ErrorAction Continue
    }
    exit $exitCode
}
