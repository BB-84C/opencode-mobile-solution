#Requires -Version 7.2

# OAuth machine authorization, heartbeat agent, and managed SSH+FRPC tunnel for the
# Windows relay controller. Spec: docs/windows-opencode-relay-oauth-spec.md.
# This module layers on opencode-relay-common.psm1 (the ownership-safe core) and
# never bypasses its identity rules: every destructive action revalidates PID +
# creation time + executable path immediately before acting. A recycled PID is
# foreign and is never killed.

Import-Module (Join-Path $PSScriptRoot 'opencode-relay-common.psm1') -ErrorAction Stop -DisableNameChecking -WarningAction SilentlyContinue

function Get-RelayMachineConfig {
    param(
        [Parameter(Mandatory)][psobject]$Config,
        [hashtable]$UserEnvironment
    )

    if ($null -eq $UserEnvironment) {
        $UserEnvironment = @{}
        foreach ($name in @('OPENCODE_RELAY_ORIGIN', 'OPENCODE_RELAY_SSH_ALIAS', 'OPENCODE_FRPC_EXE', 'OPENCODE_RELAY_CONFIG_DIR', 'OPENCODE_RELAY_REQUESTED_TARGET', 'OPENCODE_RELAY_REQUESTED_PORT', 'OPENCODE_RELAY_SUPERVISOR_INTERVAL_MS')) {
            $value = Get-UserEnvironmentValue -Name $name
            if ($null -ne $value) { $UserEnvironment[$name] = $value }
        }
    }

    $readKnob = {
        param($name, $default)
        if ($UserEnvironment.ContainsKey($name) -and -not [string]::IsNullOrWhiteSpace([string]$UserEnvironment[$name])) { [string]$UserEnvironment[$name] } else { $default }
    }

    $configDir = & $readKnob 'OPENCODE_RELAY_CONFIG_DIR' (Join-Path $env:USERPROFILE '.config\opencode-relay')
    $stateRoot = [string]$Config.StateRoot
    $logRoot = Join-Path $stateRoot 'machine-logs'

    # Resident supervisor heal cadence. Floored so a misconfigured value cannot
    # turn the watchdog into a tight busy-loop.
    $supervisorIntervalMs = 30000
    $supervisorIntervalKnob = & $readKnob 'OPENCODE_RELAY_SUPERVISOR_INTERVAL_MS' ''
    if (-not [string]::IsNullOrWhiteSpace($supervisorIntervalKnob)) {
        $parsedSupervisorInterval = 0
        if ([int]::TryParse($supervisorIntervalKnob, [ref]$parsedSupervisorInterval) -and $parsedSupervisorInterval -ge 10000) {
            $supervisorIntervalMs = $parsedSupervisorInterval
        }
    }

    return [PSCustomObject]@{
        RelayOrigin = (& $readKnob 'OPENCODE_RELAY_ORIGIN' 'https://opencode.example.com').TrimEnd('/')
        SshAlias = & $readKnob 'OPENCODE_RELAY_SSH_ALIAS' 'opencode-vps'
        FrpcExecutable = & $readKnob 'OPENCODE_FRPC_EXE' "$env:LOCALAPPDATA\opencode-relay\frp\frpc.exe"
        RequestedTargetID = & $readKnob 'OPENCODE_RELAY_REQUESTED_TARGET' $null
        RequestedRemotePort = & $readKnob 'OPENCODE_RELAY_REQUESTED_PORT' $null
        ConfigDir = $configDir
        CredentialPath = Join-Path $configDir 'machine.json'
        FrpcConfigPath = Join-Path $configDir 'frpc.toml'
        StateRoot = $stateRoot
        LogRoot = $logRoot
        AgentStatePath = Join-Path $stateRoot 'machine-agent-process.json'
        AgentStatusPath = Join-Path $stateRoot 'machine-agent-status.json'
        AgentStopSentinelPath = Join-Path $stateRoot 'machine-agent-stop.request'
        SshStatePath = Join-Path $stateRoot 'tunnel-ssh-process.json'
        FrpcStatePath = Join-Path $stateRoot 'tunnel-frpc-process.json'
        AuthModule = Join-Path $PSScriptRoot 'opencode-machine-auth.mjs'
        AgentModule = Join-Path $PSScriptRoot 'opencode-machine-agent.mjs'
        DaemonLauncher = Join-Path $PSScriptRoot 'opencode-daemon-launcher.mjs'
        SupervisorModule = Join-Path $PSScriptRoot 'opencode-relay-supervisor.ps1'
        SupervisorStatePath = Join-Path $stateRoot 'tunnel-supervisor-process.json'
        SupervisorStatusPath = Join-Path $stateRoot 'tunnel-supervisor-status.json'
        SupervisorStopSentinelPath = Join-Path $stateRoot 'tunnel-supervisor-stop.request'
        SupervisorIntervalMs = $supervisorIntervalMs
    }
}

function Read-RelayMachineCredentialSummary {
    # Returns ONLY non-secret projections of machine.json. The access token and any
    # transport secret never leave the file through this function.
    param([Parameter(Mandatory)][psobject]$MachineConfig)

    if (-not (Test-Path -LiteralPath $MachineConfig.CredentialPath -PathType Leaf)) { return $null }
    try {
        $raw = [IO.File]::ReadAllText($MachineConfig.CredentialPath) | ConvertFrom-Json -ErrorAction Stop
    }
    catch { return $null }
    if ($null -eq $raw -or $null -eq $raw.machine) { return $null }
    return [PSCustomObject]@{
        MachineID = [string]$raw.machine.machineID
        TargetID = [string]$raw.machine.targetID
        RemotePort = if ($null -ne $raw.transport) { $raw.transport.remotePort } else { $null }
        LocalForwardPort = if ($null -ne $raw.transport -and $null -ne $raw.transport.localForwardPort) { [int]$raw.transport.localForwardPort } else { 17000 }
        FrpServerPort = if ($null -ne $raw.transport -and $null -ne $raw.transport.frpServerPort) { [int]$raw.transport.frpServerPort } else { 7000 }
        RelayOrigin = [string]$raw.relayOrigin
        AuthorizedAt = [string]$raw.authorizedAt
    }
}

function Invoke-RelayMachineAuth {
    param(
        [Parameter(Mandatory)][psobject]$Config,
        [Parameter(Mandatory)][psobject]$MachineConfig,
        [Parameter(Mandatory)][ValidateSet('status', 'ensure')][string]$Action,
        [scriptblock]$AuthProvider,
        [int]$TimeoutMs = 0
    )

    if ($null -ne $AuthProvider) { return & $AuthProvider $Action $Config $MachineConfig }
    if ($TimeoutMs -le 0) { $TimeoutMs = if ($Action -eq 'ensure') { 660000 } else { 20000 } }
    if (-not (Test-Path -LiteralPath $MachineConfig.AuthModule -PathType Leaf)) {
        throw 'Machine authorization client is missing.'
    }

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = (Get-Command node -ErrorAction Stop).Source
    $startInfo.ArgumentList.Add([string]$MachineConfig.AuthModule)
    $startInfo.ArgumentList.Add($Action)
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    # stderr stays inherited: the device flow prints the verification URL and code
    # there, and the human must see them. Secrets never travel on stderr.
    $startInfo.Environment['OPENCODE_SERVER_USERNAME'] = [string]$Config.Username
    $startInfo.Environment['OPENCODE_SERVER_PASSWORD'] = [string]$Config.Password
    $startInfo.Environment['OPENCODE_SERVER_PORT'] = [string][int]$Config.Port
    $startInfo.Environment['OPENCODE_RELAY_ORIGIN'] = [string]$MachineConfig.RelayOrigin
    $startInfo.Environment['OPENCODE_RELAY_CONFIG_DIR'] = [string]$MachineConfig.ConfigDir
    $startInfo.Environment['OPENCODE_RELAY_SSH_ALIAS'] = [string]$MachineConfig.SshAlias
    if (-not [string]::IsNullOrWhiteSpace([string]$MachineConfig.RequestedTargetID)) {
        $startInfo.Environment['OPENCODE_RELAY_REQUESTED_TARGET'] = [string]$MachineConfig.RequestedTargetID
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$MachineConfig.RequestedRemotePort)) {
        $startInfo.Environment['OPENCODE_RELAY_REQUESTED_PORT'] = [string]$MachineConfig.RequestedRemotePort
    }

    $process = [Diagnostics.Process]::Start($startInfo)
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutMs)) {
        try { $process.Kill($true) } catch { }
        $null = $process.WaitForExit(2000)
        return [PSCustomObject]@{ Status = 'Unavailable'; Machine = $null; Reason = 'auth_client_timeout'; ExitCode = 7 }
    }
    $exitCode = $process.ExitCode
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $process.Dispose()
    $parsed = $null
    foreach ($line in ($stdout -split "`r?`n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $parsed = $line | ConvertFrom-Json -ErrorAction Stop } catch { }
    }
    if ($null -eq $parsed -or $null -eq $parsed.PSObject.Properties['Status']) {
        $reason = if ($exitCode -eq 6) { 'authorization_denied_or_revoked' } elseif ($exitCode -eq 7) { 'relay_unavailable' } else { 'auth_client_failed' }
        return [PSCustomObject]@{ Status = 'Unavailable'; Machine = $null; Reason = $reason; ExitCode = $exitCode }
    }
    return [PSCustomObject]@{ Status = [string]$parsed.Status; Machine = $parsed.Machine; Reason = $parsed.Reason; ExitCode = $exitCode }
}

function ConvertTo-RelayMachineAuthorizationView {
    param($AuthResult)
    if ($null -eq $AuthResult) { return [PSCustomObject]@{ Status = 'Unavailable'; MachineID = $null; TargetID = $null; Reason = $null } }
    return [PSCustomObject]@{
        Status = [string]$AuthResult.Status
        MachineID = if ($null -ne $AuthResult.Machine) { [string]$AuthResult.Machine.machineID } else { $null }
        TargetID = if ($null -ne $AuthResult.Machine) { [string]$AuthResult.Machine.targetID } else { $null }
        Reason = $AuthResult.Reason
    }
}

function Write-RelayMachineStateFile {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N').Substring(0, 8)).tmp"
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 6 -Compress))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Read-RelayMachineProcessState {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try {
        $state = [IO.File]::ReadAllText($Path) | ConvertFrom-Json -ErrorAction Stop
        if ($null -eq $state -or [int]$state.schema -ne 1 -or $null -eq $state.process -or [int]$state.process.pid -lt 1) { return $null }
        return $state
    }
    catch { return $null }
}

function ConvertTo-RelayMachineUtcText {
    # ConvertFrom-Json revives ISO-8601 strings as [datetime]; normalize both the
    # recorded and the live value to one round-trip UTC text before comparing.
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [datetime]) { return $Value.ToUniversalTime().ToString('o') }
    $parsed = [datetime]::MinValue
    if ([datetime]::TryParse([string]$Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsed)) {
        return $parsed.ToUniversalTime().ToString('o')
    }
    return [string]$Value
}

function Test-RelayMachineProcessIdentity {
    # Identity = PID + creation time + executable path, matching the core's backend
    # identity convention. Any mismatch means the PID was recycled: report, never kill.
    param(
        [Parameter(Mandatory)]$RecordedProcess,
        [scriptblock]$ProcessProvider
    )

    $info = Get-RelayProcessInfo -ProcessId ([int]$RecordedProcess.pid) -ProcessProvider $ProcessProvider
    if ($info.Status -ne 'Available') { return [PSCustomObject]@{ Match = $false; Live = $false; Info = $info } }
    if ((ConvertTo-RelayMachineUtcText -Value $info.CreationTimeUtc) -cne (ConvertTo-RelayMachineUtcText -Value $RecordedProcess.createdUtc)) { return [PSCustomObject]@{ Match = $false; Live = $true; Info = $info } }
    if ([string]$info.ExecutablePath -ine [string]$RecordedProcess.executable) { return [PSCustomObject]@{ Match = $false; Live = $true; Info = $info } }
    return [PSCustomObject]@{ Match = $true; Live = $true; Info = $info }
}

function Start-RelayMachineDaemonProcess {
    param(
        [Parameter(Mandatory)][psobject]$MachineConfig,
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Arguments,
        [Parameter(Mandatory)][string]$LogPrefix,
        [hashtable]$EnvMap,
        [scriptblock]$DaemonProvider
    )

    if ($null -ne $DaemonProvider) {
        return [int](& $DaemonProvider ([PSCustomObject]@{ Executable = $Executable; Arguments = $Arguments; LogPrefix = $LogPrefix; EnvMap = $EnvMap }))
    }
    if (-not (Test-Path -LiteralPath $MachineConfig.DaemonLauncher -PathType Leaf)) { throw 'OpenCode daemon launcher was not found.' }
    [IO.Directory]::CreateDirectory([string]$MachineConfig.LogRoot) | Out-Null
    $launchId = [guid]::NewGuid().ToString('N')
    $stdoutPath = Join-Path ([string]$MachineConfig.LogRoot) ("$LogPrefix-$launchId.stdout.log")
    $stderrPath = Join-Path ([string]$MachineConfig.LogRoot) ("$LogPrefix-$launchId.stderr.log")

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = (Get-Command node -ErrorAction Stop).Source
    $startInfo.ArgumentList.Add([string]$MachineConfig.DaemonLauncher)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    if ($null -ne $EnvMap) {
        foreach ($key in $EnvMap.Keys) { $startInfo.Environment[[string]$key] = [string]$EnvMap[$key] }
    }
    $launcher = [Diagnostics.Process]::Start($startInfo)
    $envelope = @{ executable = $Executable; args = @($Arguments); stdoutPath = $stdoutPath; stderrPath = $stderrPath } | ConvertTo-Json -Compress
    $launcher.StandardInput.Write($envelope)
    $launcher.StandardInput.Close()
    $handshakeLine = $launcher.StandardOutput.ReadLine()
    if (-not $launcher.WaitForExit(5000)) {
        try { $launcher.Kill($true) } catch { }
        throw 'Machine daemon launcher did not exit within five seconds.'
    }
    $handshake = try { $handshakeLine | ConvertFrom-Json -ErrorAction Stop } catch { throw "Machine daemon launcher returned an invalid handshake: $($launcher.StandardError.ReadToEnd())" }
    $launcher.Dispose()
    if ($null -eq $handshake.pid -or [int]$handshake.pid -le 0) { throw 'Machine daemon launcher returned no child PID.' }
    return [int]$handshake.pid
}

function Wait-RelayMachineProcessCapture {
    param(
        [Parameter(Mandatory)][int]$ProcessId,
        [Parameter(Mandatory)][string]$ExpectedExecutable,
        [scriptblock]$ProcessProvider,
        [scriptblock]$SleepProvider,
        [int]$TimeoutMs = 5000,
        [string]$LogRoot
    )

    $deadline = [datetime]::UtcNow.AddMilliseconds($TimeoutMs)
    do {
        $info = Get-RelayProcessInfo -ProcessId $ProcessId -ProcessProvider $ProcessProvider
        if ($info.Status -eq 'Available') {
            if ([string]$info.ExecutablePath -ine $ExpectedExecutable) { throw "Launched process identity mismatch: expected $ExpectedExecutable." }
            return $info
        }
        if ($null -ne $SleepProvider) { & $SleepProvider 100 } else { Start-Sleep -Milliseconds 100 }
    } while ([datetime]::UtcNow -lt $deadline)
    $hint = if ([string]::IsNullOrWhiteSpace($LogRoot)) { '' } else { " Inspect $LogRoot for its stderr log." }
    throw "Launched process could not be identity-captured before the deadline; it may have exited immediately.$hint"
}

# --- Heartbeat agent -----------------------------------------------------------

function Get-RelayMachineAgentStatus {
    param(
        [Parameter(Mandatory)][psobject]$MachineConfig,
        [scriptblock]$ProcessProvider
    )

    $state = Read-RelayMachineProcessState -Path $MachineConfig.AgentStatePath
    $status = 'Stopped'
    $processId = $null
    if ($null -ne $state) {
        $processId = [int]$state.process.pid
        $identity = Test-RelayMachineProcessIdentity -RecordedProcess $state.process -ProcessProvider $ProcessProvider
        $status = if ($identity.Match) { 'Running' } else { 'Stale' }
    }
    $heartbeat = $null
    if (Test-Path -LiteralPath $MachineConfig.AgentStatusPath -PathType Leaf) {
        try { $heartbeat = [IO.File]::ReadAllText($MachineConfig.AgentStatusPath) | ConvertFrom-Json -ErrorAction Stop } catch { }
    }
    $lastAccepted = $null
    if ($null -ne $heartbeat -and [string]$heartbeat.status -in @('Ready', 'Stopped') -and $null -ne $heartbeat.PSObject.Properties['updatedAt']) {
        $lastAccepted = ConvertTo-RelayMachineUtcText -Value $heartbeat.updatedAt
    }
    return [PSCustomObject]@{
        Status = $status
        PID = $processId
        LastAcceptedAt = $lastAccepted
        Heartbeat = $heartbeat
    }
}

function Start-RelayMachineAgent {
    param(
        [Parameter(Mandatory)][psobject]$Config,
        [Parameter(Mandatory)][psobject]$MachineConfig,
        [scriptblock]$ProcessProvider,
        [scriptblock]$DaemonProvider,
        [scriptblock]$SleepProvider
    )

    $existing = Read-RelayMachineProcessState -Path $MachineConfig.AgentStatePath
    if ($null -ne $existing) {
        $identity = Test-RelayMachineProcessIdentity -RecordedProcess $existing.process -ProcessProvider $ProcessProvider
        if ($identity.Match) { return Get-RelayMachineAgentStatus -MachineConfig $MachineConfig -ProcessProvider $ProcessProvider }
        Remove-Item -LiteralPath $MachineConfig.AgentStatePath -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path -LiteralPath $MachineConfig.AgentModule -PathType Leaf)) { throw 'Machine heartbeat agent module is missing.' }
    if (-not (Test-Path -LiteralPath $MachineConfig.CredentialPath -PathType Leaf)) { throw 'Machine credential is missing; run authorization first.' }
    # A leftover stop request would make the fresh agent exit immediately.
    Remove-Item -LiteralPath $MachineConfig.AgentStopSentinelPath -Force -ErrorAction SilentlyContinue

    $nodeExecutable = (Get-Command node -ErrorAction Stop).Source
    $envMap = @{
        OPENCODE_SERVER_USERNAME = [string]$Config.Username
        OPENCODE_SERVER_PASSWORD = [string]$Config.Password
        OPENCODE_SERVER_PORT = [string][int]$Config.Port
        OPENCODE_RELAY_CONFIG_DIR = [string]$MachineConfig.ConfigDir
        OPENCODE_MACHINE_AGENT_STATUS = [string]$MachineConfig.AgentStatusPath
        OPENCODE_MACHINE_AGENT_STOP = [string]$MachineConfig.AgentStopSentinelPath
    }
    $agentPid = Start-RelayMachineDaemonProcess -MachineConfig $MachineConfig -Executable $nodeExecutable -Arguments @([string]$MachineConfig.AgentModule) -LogPrefix 'machine-agent' -EnvMap $envMap -DaemonProvider $DaemonProvider
    $info = Wait-RelayMachineProcessCapture -ProcessId $agentPid -ExpectedExecutable $nodeExecutable -ProcessProvider $ProcessProvider -SleepProvider $SleepProvider -LogRoot ([string]$MachineConfig.LogRoot)
    Write-RelayMachineStateFile -Path $MachineConfig.AgentStatePath -Value ([PSCustomObject]@{
        schema = 1
        process = [PSCustomObject]@{ pid = [int]$info.PID; createdUtc = $info.CreationTimeUtc; executable = $info.ExecutablePath; parentPid = $info.ParentPID }
    })
    return Get-RelayMachineAgentStatus -MachineConfig $MachineConfig -ProcessProvider $ProcessProvider
}

function Stop-RelayMachineAgent {
    param(
        [Parameter(Mandatory)][psobject]$MachineConfig,
        [scriptblock]$ProcessProvider,
        [scriptblock]$SleepProvider,
        [int]$GracefulTimeoutMs = 15000
    )

    $warnings = [Collections.Generic.List[string]]::new()
    $state = Read-RelayMachineProcessState -Path $MachineConfig.AgentStatePath
    if ($null -eq $state) {
        Remove-Item -LiteralPath $MachineConfig.AgentStatePath -Force -ErrorAction SilentlyContinue
        return [PSCustomObject]@{ Status = 'Stopped'; Warnings = @($warnings) }
    }
    $identity = Test-RelayMachineProcessIdentity -RecordedProcess $state.process -ProcessProvider $ProcessProvider
    if (-not $identity.Match) {
        # Live-but-mismatched means the recorded PID was recycled by a foreign
        # process. Remove only our stale record; never touch the foreign PID.
        Remove-Item -LiteralPath $MachineConfig.AgentStatePath -Force -ErrorAction SilentlyContinue
        if ($identity.Live) { $warnings.Add('Stale agent state removed; a foreign process now owns the recorded PID and was left untouched.') }
        return [PSCustomObject]@{ Status = 'Stopped'; Warnings = @($warnings) }
    }

    # Graceful path: the sentinel asks the agent to send its final stopped
    # heartbeat and exit on its own.
    [IO.Directory]::CreateDirectory((Split-Path -Parent $MachineConfig.AgentStopSentinelPath)) | Out-Null
    [IO.File]::WriteAllText([string]$MachineConfig.AgentStopSentinelPath, "stop`n")
    $deadline = [datetime]::UtcNow.AddMilliseconds($GracefulTimeoutMs)
    do {
        $check = Test-RelayMachineProcessIdentity -RecordedProcess $state.process -ProcessProvider $ProcessProvider
        if (-not $check.Match) {
            Remove-Item -LiteralPath $MachineConfig.AgentStatePath -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $MachineConfig.AgentStopSentinelPath -Force -ErrorAction SilentlyContinue
            return [PSCustomObject]@{ Status = 'Stopped'; Warnings = @($warnings) }
        }
        if ($null -ne $SleepProvider) { & $SleepProvider 500 } else { Start-Sleep -Milliseconds 500 }
    } while ([datetime]::UtcNow -lt $deadline)

    # Stubborn agent: revalidate identity immediately before the kill.
    $final = Test-RelayMachineProcessIdentity -RecordedProcess $state.process -ProcessProvider $ProcessProvider
    if ($final.Match) {
        $warnings.Add('Agent did not honor the stop request; it was terminated and the final stopped heartbeat may be missing.')
        try { Stop-Process -Id ([int]$state.process.pid) -Force -ErrorAction Stop } catch { }
        if ($null -ne $SleepProvider) { & $SleepProvider 500 } else { Start-Sleep -Milliseconds 500 }
        $post = Test-RelayMachineProcessIdentity -RecordedProcess $state.process -ProcessProvider $ProcessProvider
        if ($post.Match) {
            return [PSCustomObject]@{ Status = 'Degraded'; Warnings = @($warnings + 'Agent process survived termination.') }
        }
    }
    Remove-Item -LiteralPath $MachineConfig.AgentStatePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $MachineConfig.AgentStopSentinelPath -Force -ErrorAction SilentlyContinue
    return [PSCustomObject]@{ Status = 'Stopped'; Warnings = @($warnings) }
}

# --- Resident tunnel supervisor (self-heal watchdog) ----------------------------
# Structurally parallels the heartbeat agent: launched detached by the daemon
# launcher, tracked by a state file + PID/creation-time/executable identity, and
# stopped by a sentinel with a never-kill-foreign fallback. Its loop lives in
# opencode-relay-supervisor.ps1 and re-converges only the tunnel.

function Get-RelaySupervisorStatus {
    param(
        [Parameter(Mandatory)][psobject]$MachineConfig,
        [scriptblock]$ProcessProvider
    )

    $state = Read-RelayMachineProcessState -Path $MachineConfig.SupervisorStatePath
    $status = 'Stopped'
    $processId = $null
    if ($null -ne $state) {
        $processId = [int]$state.process.pid
        $identity = Test-RelayMachineProcessIdentity -RecordedProcess $state.process -ProcessProvider $ProcessProvider
        $status = if ($identity.Match) { 'Running' } else { 'Stale' }
    }
    $heal = $null
    if (Test-Path -LiteralPath $MachineConfig.SupervisorStatusPath -PathType Leaf) {
        try { $heal = [IO.File]::ReadAllText($MachineConfig.SupervisorStatusPath) | ConvertFrom-Json -ErrorAction Stop } catch { }
    }
    $lastHealAt = $null
    $lastTunnelStatus = $null
    if ($null -ne $heal) {
        if ($null -ne $heal.PSObject.Properties['lastHealAt']) { $lastHealAt = ConvertTo-RelayMachineUtcText -Value $heal.lastHealAt }
        if ($null -ne $heal.PSObject.Properties['lastTunnelStatus']) { $lastTunnelStatus = [string]$heal.lastTunnelStatus }
    }
    return [PSCustomObject]@{
        Status = $status
        PID = $processId
        LastHealAt = $lastHealAt
        LastTunnelStatus = $lastTunnelStatus
    }
}

function Start-RelaySupervisor {
    param(
        [Parameter(Mandatory)][psobject]$Config,
        [Parameter(Mandatory)][psobject]$MachineConfig,
        [scriptblock]$ProcessProvider,
        [scriptblock]$DaemonProvider,
        [scriptblock]$SleepProvider
    )

    $existing = Read-RelayMachineProcessState -Path $MachineConfig.SupervisorStatePath
    if ($null -ne $existing) {
        $identity = Test-RelayMachineProcessIdentity -RecordedProcess $existing.process -ProcessProvider $ProcessProvider
        if ($identity.Match) { return Get-RelaySupervisorStatus -MachineConfig $MachineConfig -ProcessProvider $ProcessProvider }
        Remove-Item -LiteralPath $MachineConfig.SupervisorStatePath -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path -LiteralPath $MachineConfig.SupervisorModule -PathType Leaf)) { throw 'Tunnel supervisor module is missing.' }
    if (-not (Test-Path -LiteralPath $MachineConfig.CredentialPath -PathType Leaf)) { throw 'Machine credential is missing; run authorization first.' }
    # A leftover stop request would make the fresh supervisor exit immediately.
    Remove-Item -LiteralPath $MachineConfig.SupervisorStopSentinelPath -Force -ErrorAction SilentlyContinue

    $pwshExecutable = (Get-Command pwsh -ErrorAction Stop).Source
    # The daemon launcher spawns with node's detached flag, which terminates a
    # directly spawned pwsh child immediately (native cmd/ssh/frpc and node all
    # survive it). Wrap pwsh in cmd.exe: the detached survivor is cmd, which then
    # hosts the resident pwsh supervisor. The tracked/captured process is cmd.
    $commandProcessor = if ([string]::IsNullOrWhiteSpace([string]$env:ComSpec)) { 'cmd.exe' } else { [string]$env:ComSpec }
    $envMap = @{
        OPENCODE_SERVER_PORT = [string][int]$Config.Port
        OPENCODE_SERVER_USERNAME = [string]$Config.Username
        OPENCODE_SERVER_PASSWORD = [string]$Config.Password
        OPENCODE_RELAY_CONFIG_DIR = [string]$MachineConfig.ConfigDir
        OPENCODE_RELAY_ORIGIN = [string]$MachineConfig.RelayOrigin
        OPENCODE_RELAY_SSH_ALIAS = [string]$MachineConfig.SshAlias
        OPENCODE_FRPC_EXE = [string]$MachineConfig.FrpcExecutable
        OPENCODE_RELAY_SUPERVISOR_INTERVAL_MS = [string][int]$MachineConfig.SupervisorIntervalMs
    }
    $arguments = @('/d', '/c', $pwshExecutable, '-NoProfile', '-NoLogo', '-File', [string]$MachineConfig.SupervisorModule)
    $supervisorPid = Start-RelayMachineDaemonProcess -MachineConfig $MachineConfig -Executable $commandProcessor -Arguments $arguments -LogPrefix 'tunnel-supervisor' -EnvMap $envMap -DaemonProvider $DaemonProvider
    $info = Wait-RelayMachineProcessCapture -ProcessId $supervisorPid -ExpectedExecutable $commandProcessor -ProcessProvider $ProcessProvider -SleepProvider $SleepProvider -LogRoot ([string]$MachineConfig.LogRoot)
    Write-RelayMachineStateFile -Path $MachineConfig.SupervisorStatePath -Value ([PSCustomObject]@{
        schema = 1
        process = [PSCustomObject]@{ pid = [int]$info.PID; createdUtc = $info.CreationTimeUtc; executable = $info.ExecutablePath; parentPid = $info.ParentPID }
    })
    return Get-RelaySupervisorStatus -MachineConfig $MachineConfig -ProcessProvider $ProcessProvider
}

function Stop-RelaySupervisor {
    param(
        [Parameter(Mandatory)][psobject]$MachineConfig,
        [scriptblock]$ProcessProvider,
        [scriptblock]$SleepProvider,
        [int]$GracefulTimeoutMs = 10000
    )

    $warnings = [Collections.Generic.List[string]]::new()
    $state = Read-RelayMachineProcessState -Path $MachineConfig.SupervisorStatePath
    if ($null -eq $state) {
        Remove-Item -LiteralPath $MachineConfig.SupervisorStatePath -Force -ErrorAction SilentlyContinue
        return [PSCustomObject]@{ Status = 'Stopped'; Warnings = @($warnings) }
    }
    $identity = Test-RelayMachineProcessIdentity -RecordedProcess $state.process -ProcessProvider $ProcessProvider
    if (-not $identity.Match) {
        # Live-but-mismatched means the recorded PID was recycled by a foreign
        # process. Remove only our stale record; never touch the foreign PID.
        Remove-Item -LiteralPath $MachineConfig.SupervisorStatePath -Force -ErrorAction SilentlyContinue
        if ($identity.Live) { $warnings.Add('Stale supervisor state removed; a foreign process now owns the recorded PID and was left untouched.') }
        return [PSCustomObject]@{ Status = 'Stopped'; Warnings = @($warnings) }
    }

    # Graceful path: the sentinel asks the supervisor to exit on its own.
    [IO.Directory]::CreateDirectory((Split-Path -Parent $MachineConfig.SupervisorStopSentinelPath)) | Out-Null
    [IO.File]::WriteAllText([string]$MachineConfig.SupervisorStopSentinelPath, "stop`n")
    $deadline = [datetime]::UtcNow.AddMilliseconds($GracefulTimeoutMs)
    do {
        $check = Test-RelayMachineProcessIdentity -RecordedProcess $state.process -ProcessProvider $ProcessProvider
        if (-not $check.Match) {
            Remove-Item -LiteralPath $MachineConfig.SupervisorStatePath -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $MachineConfig.SupervisorStopSentinelPath -Force -ErrorAction SilentlyContinue
            return [PSCustomObject]@{ Status = 'Stopped'; Warnings = @($warnings) }
        }
        if ($null -ne $SleepProvider) { & $SleepProvider 250 } else { Start-Sleep -Milliseconds 250 }
    } while ([datetime]::UtcNow -lt $deadline)

    # Stubborn supervisor: revalidate identity immediately before the kill.
    $final = Test-RelayMachineProcessIdentity -RecordedProcess $state.process -ProcessProvider $ProcessProvider
    if ($final.Match) {
        $warnings.Add('Supervisor did not honor the stop request; it was terminated.')
        # The tracked process is the cmd host; tree-kill so its pwsh child dies too.
        $supervisorKillPid = [int]$state.process.pid
        try { & taskkill.exe /F /T /PID $supervisorKillPid 2>&1 | Out-Null } catch { try { Stop-Process -Id $supervisorKillPid -Force -ErrorAction Stop } catch { } }
        if ($null -ne $SleepProvider) { & $SleepProvider 500 } else { Start-Sleep -Milliseconds 500 }
        $post = Test-RelayMachineProcessIdentity -RecordedProcess $state.process -ProcessProvider $ProcessProvider
        if ($post.Match) {
            return [PSCustomObject]@{ Status = 'Degraded'; Warnings = @($warnings + 'Supervisor process survived termination.') }
        }
    }
    Remove-Item -LiteralPath $MachineConfig.SupervisorStatePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $MachineConfig.SupervisorStopSentinelPath -Force -ErrorAction SilentlyContinue
    return [PSCustomObject]@{ Status = 'Stopped'; Warnings = @($warnings) }
}

# --- Managed tunnel (SSH local forward + FRPC) ----------------------------------

function Get-RelayManagedTunnelComponentStatus {
    param(
        [Parameter(Mandatory)][string]$StatePath,
        [scriptblock]$ProcessProvider
    )

    $state = Read-RelayMachineProcessState -Path $StatePath
    if ($null -eq $state) { return [PSCustomObject]@{ Status = 'Stopped'; PID = $null } }
    $identity = Test-RelayMachineProcessIdentity -RecordedProcess $state.process -ProcessProvider $ProcessProvider
    return [PSCustomObject]@{
        Status = if ($identity.Match) { 'Running' } else { 'Stale' }
        PID = [int]$state.process.pid
    }
}

function Get-RelayManagedTunnelStatus {
    param(
        [Parameter(Mandatory)][psobject]$MachineConfig,
        [scriptblock]$ProcessProvider
    )

    $ssh = Get-RelayManagedTunnelComponentStatus -StatePath $MachineConfig.SshStatePath -ProcessProvider $ProcessProvider
    $frpc = Get-RelayManagedTunnelComponentStatus -StatePath $MachineConfig.FrpcStatePath -ProcessProvider $ProcessProvider
    $status = if ($ssh.Status -eq 'Running' -and $frpc.Status -eq 'Running') { 'Running' }
    elseif ($ssh.Status -eq 'Stopped' -and $frpc.Status -eq 'Stopped') { 'Stopped' }
    else { 'Degraded' }
    return [PSCustomObject]@{
        Status = $status
        SSHPID = if ($ssh.Status -eq 'Running') { $ssh.PID } else { $null }
        FRPCPID = if ($frpc.Status -eq 'Running') { $frpc.PID } else { $null }
        Components = [PSCustomObject]@{ Ssh = $ssh; Frpc = $frpc }
    }
}

function Start-RelayManagedTunnelComponent {
    param(
        [Parameter(Mandatory)][psobject]$MachineConfig,
        [Parameter(Mandatory)][string]$StatePath,
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Arguments,
        [Parameter(Mandatory)][string]$LogPrefix,
        [scriptblock]$ProcessProvider,
        [scriptblock]$DaemonProvider,
        [scriptblock]$SleepProvider,
        [int]$StabilizationMs = 1500
    )

    $existing = Read-RelayMachineProcessState -Path $StatePath
    if ($null -ne $existing) {
        $identity = Test-RelayMachineProcessIdentity -RecordedProcess $existing.process -ProcessProvider $ProcessProvider
        if ($identity.Match) { return [PSCustomObject]@{ Status = 'Running'; PID = [int]$existing.process.pid; Reused = $true } }
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
    }

    $componentPid = Start-RelayMachineDaemonProcess -MachineConfig $MachineConfig -Executable $Executable -Arguments $Arguments -LogPrefix $LogPrefix -DaemonProvider $DaemonProvider
    $info = Wait-RelayMachineProcessCapture -ProcessId $componentPid -ExpectedExecutable $Executable -ProcessProvider $ProcessProvider -SleepProvider $SleepProvider -LogRoot ([string]$MachineConfig.LogRoot)
    # ssh/frpc die quickly on auth or config failure; require a short survival window
    # before recording ownership.
    if ($null -ne $SleepProvider) { & $SleepProvider $StabilizationMs } else { Start-Sleep -Milliseconds $StabilizationMs }
    $post = Get-RelayProcessInfo -ProcessId $componentPid -ProcessProvider $ProcessProvider
    if ($post.Status -ne 'Available' -or [string]$post.CreationTimeUtc -cne [string]$info.CreationTimeUtc) {
        throw "$LogPrefix exited immediately after launch; inspect $($MachineConfig.LogRoot) for its stderr log."
    }
    Write-RelayMachineStateFile -Path $StatePath -Value ([PSCustomObject]@{
        schema = 1
        component = $LogPrefix
        process = [PSCustomObject]@{ pid = [int]$info.PID; createdUtc = $info.CreationTimeUtc; executable = $info.ExecutablePath; parentPid = $info.ParentPID }
    })
    return [PSCustomObject]@{ Status = 'Running'; PID = [int]$info.PID; Reused = $false }
}

function Wait-RelaySshForwardReady {
    # FRPC exits on its first failed login by default, so the data channel must not
    # launch until the SSH local forward actually accepts TCP connections.
    param(
        [Parameter(Mandatory)][int]$Port,
        [scriptblock]$SleepProvider,
        [int]$TimeoutMs = 15000
    )

    $deadline = [datetime]::UtcNow.AddMilliseconds($TimeoutMs)
    do {
        $client = [Net.Sockets.TcpClient]::new()
        try {
            $connect = $client.ConnectAsync('127.0.0.1', $Port)
            if ($connect.Wait(1000) -and $client.Connected) { return $true }
        }
        catch { }
        finally { $client.Dispose() }
        if ($null -ne $SleepProvider) { & $SleepProvider 250 } else { Start-Sleep -Milliseconds 250 }
    } while ([datetime]::UtcNow -lt $deadline)
    return $false
}

function Start-RelayManagedTunnel {
    param(
        [Parameter(Mandatory)][psobject]$Config,
        [Parameter(Mandatory)][psobject]$MachineConfig,
        [scriptblock]$ProcessProvider,
        [scriptblock]$DaemonProvider,
        [scriptblock]$SleepProvider,
        [scriptblock]$ForwardProbeProvider
    )

    $credential = Read-RelayMachineCredentialSummary -MachineConfig $MachineConfig
    if ($null -eq $credential) { throw 'Machine credential is missing; run authorization first.' }
    if (-not (Test-Path -LiteralPath $MachineConfig.FrpcConfigPath -PathType Leaf)) { throw 'FRPC configuration is missing; run authorization first.' }
    if (-not (Test-Path -LiteralPath $MachineConfig.FrpcExecutable -PathType Leaf)) { throw "FRPC executable was not found at $($MachineConfig.FrpcExecutable)." }

    $sshExecutable = (Get-Command ssh.exe -ErrorAction Stop).Source
    $sshArguments = @(
        '-o', 'BatchMode=yes',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ConnectTimeout=10',
        '-N',
        '-L', "$($credential.LocalForwardPort):127.0.0.1:$($credential.FrpServerPort)",
        [string]$MachineConfig.SshAlias
    )
    $ssh = Start-RelayManagedTunnelComponent -MachineConfig $MachineConfig -StatePath $MachineConfig.SshStatePath -Executable $sshExecutable -Arguments $sshArguments -LogPrefix 'tunnel-ssh' -ProcessProvider $ProcessProvider -DaemonProvider $DaemonProvider -SleepProvider $SleepProvider

    # Gate the data channel on control-channel readiness. In provider-mocked test
    # mode (DaemonProvider present) no real forward exists; a test that wants to
    # exercise this gate injects ForwardProbeProvider explicitly.
    $forwardReady = if ($null -ne $ForwardProbeProvider) { [bool](& $ForwardProbeProvider $credential.LocalForwardPort) }
    elseif ($null -eq $DaemonProvider) { Wait-RelaySshForwardReady -Port ([int]$credential.LocalForwardPort) -SleepProvider $SleepProvider }
    else { $true }
    if (-not $forwardReady) {
        throw "SSH local forward on port $($credential.LocalForwardPort) did not accept connections; inspect $($MachineConfig.LogRoot) for the tunnel-ssh stderr log."
    }

    $frpc = Start-RelayManagedTunnelComponent -MachineConfig $MachineConfig -StatePath $MachineConfig.FrpcStatePath -Executable (Get-RelayNormalizedTunnelPath -Path $MachineConfig.FrpcExecutable) -Arguments @('-c', [string]$MachineConfig.FrpcConfigPath) -LogPrefix 'tunnel-frpc' -ProcessProvider $ProcessProvider -DaemonProvider $DaemonProvider -SleepProvider $SleepProvider
    return Get-RelayManagedTunnelStatus -MachineConfig $MachineConfig -ProcessProvider $ProcessProvider
}

function Get-RelayNormalizedTunnelPath {
    param([Parameter(Mandatory)][string]$Path)
    try { return [IO.Path]::GetFullPath($Path) } catch { return $Path }
}

function Stop-RelayManagedTunnelComponent {
    param(
        [Parameter(Mandatory)][string]$StatePath,
        [Parameter(Mandatory)][string]$LogPrefix,
        [scriptblock]$ProcessProvider,
        [scriptblock]$SleepProvider,
        [Collections.Generic.List[string]]$Warnings
    )

    $state = Read-RelayMachineProcessState -Path $StatePath
    if ($null -eq $state) {
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
        return $true
    }
    $identity = Test-RelayMachineProcessIdentity -RecordedProcess $state.process -ProcessProvider $ProcessProvider
    if (-not $identity.Match) {
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
        if ($identity.Live -and $null -ne $Warnings) { $Warnings.Add("Stale $LogPrefix state removed; a foreign process now owns the recorded PID and was left untouched.") }
        return $true
    }
    try { Stop-Process -Id ([int]$state.process.pid) -Force -ErrorAction Stop } catch { }
    $deadline = [datetime]::UtcNow.AddMilliseconds(5000)
    do {
        $check = Test-RelayMachineProcessIdentity -RecordedProcess $state.process -ProcessProvider $ProcessProvider
        if (-not $check.Match) {
            Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
            return $true
        }
        if ($null -ne $SleepProvider) { & $SleepProvider 250 } else { Start-Sleep -Milliseconds 250 }
    } while ([datetime]::UtcNow -lt $deadline)
    if ($null -ne $Warnings) { $Warnings.Add("$LogPrefix process survived termination.") }
    return $false
}

function Stop-RelayManagedTunnel {
    param(
        [Parameter(Mandatory)][psobject]$MachineConfig,
        [scriptblock]$ProcessProvider,
        [scriptblock]$SleepProvider
    )

    $warnings = [Collections.Generic.List[string]]::new()
    $frpcStopped = Stop-RelayManagedTunnelComponent -StatePath $MachineConfig.FrpcStatePath -LogPrefix 'tunnel-frpc' -ProcessProvider $ProcessProvider -SleepProvider $SleepProvider -Warnings $warnings
    $sshStopped = Stop-RelayManagedTunnelComponent -StatePath $MachineConfig.SshStatePath -LogPrefix 'tunnel-ssh' -ProcessProvider $ProcessProvider -SleepProvider $SleepProvider -Warnings $warnings
    return [PSCustomObject]@{
        Status = if ($frpcStopped -and $sshStopped) { 'Stopped' } else { 'Degraded' }
        Warnings = @($warnings)
    }
}

# --- Full-relay orchestration (spec sections 4, 5, 9) ---------------------------

function Get-RelayOrchestrationSleep {
    param([scriptblock]$SleepProvider, [int]$Milliseconds)
    if ($null -ne $SleepProvider) { & $SleepProvider $Milliseconds } else { Start-Sleep -Milliseconds $Milliseconds }
}

function ConvertTo-RelayAggregateResult {
    # Composes the spec section 9 aggregate object plus its exit code.
    param(
        [Parameter(Mandatory)][psobject]$BackendStatus,
        [Parameter(Mandatory)][psobject]$Tunnel,
        [Parameter(Mandatory)][psobject]$Agent,
        [Parameter(Mandatory)][psobject]$Authorization,
        [psobject]$Supervisor = $null,
        [AllowEmptyCollection()][string[]]$ExtraWarnings = @(),
        [switch]$Mutation,
        [ValidateSet('start', 'stop', 'restart', 'status', 'doctor')][string]$Action = 'status'
    )

    $warnings = [Collections.Generic.List[string]]::new()
    foreach ($warning in @($BackendStatus.Warnings)) { $warnings.Add([string]$warning) }
    foreach ($warning in @($ExtraWarnings)) { $warnings.Add([string]$warning) }

    $backendState = [string]$BackendStatus.State
    $state = 'Degraded'
    $exitCode = 7
    if ($backendState -in @('Foreign', 'Conflict', 'Stale')) {
        $state = 'Conflict'
        $exitCode = 6
        $warnings.Add("Backend ownership requires intervention: $backendState.")
    }
    elseif ($backendState -eq 'Ready' -and $Tunnel.Status -eq 'Running' -and $Agent.Status -eq 'Running' -and $Authorization.Status -eq 'Authorized') {
        $state = 'Ready'
        $exitCode = 0
    }
    elseif ($backendState -eq 'Stopped' -and $Tunnel.Status -eq 'Stopped' -and $Agent.Status -in @('Stopped', 'Stale')) {
        $state = 'Stopped'
        # Exit 3 belongs to read-only status only. A stop mutation that reaches
        # Stopped succeeded (0); a start/restart that ends Stopped failed (7).
        $exitCode = if ($Mutation -and $Action -eq 'stop') { 0 } elseif ($Mutation) { 7 } else { 3 }
        if ($Agent.Status -eq 'Stale') { $warnings.Add('Heartbeat agent state is stale; the recorded process is gone.') }
    }
    else {
        if ($backendState -ne 'Ready') { $warnings.Add("Backend is $backendState.") }
        if ($Tunnel.Status -ne 'Running') { $warnings.Add("Tunnel is $($Tunnel.Status).") }
        if ($Agent.Status -ne 'Running') { $warnings.Add("Heartbeat agent is $($Agent.Status).") }
        if ($Authorization.Status -ne 'Authorized') { $warnings.Add("Machine authorization is $($Authorization.Status).") }
    }
    if ($Authorization.Status -eq 'Revoked') { $exitCode = 6 }
    if ($null -ne $Supervisor -and $state -ne 'Stopped' -and [string]$Supervisor.Status -ne 'Running') {
        $warnings.Add("Tunnel self-heal supervisor is $($Supervisor.Status); the tunnel will not auto-recover from a network drop.")
    }

    $result = [PSCustomObject]@{
        State = $state
        Backend = [PSCustomObject]@{
            Status = [string]$BackendStatus.Backend.Status
            PID = $BackendStatus.Backend.PID
            Generation = [int]$BackendStatus.Generation
            Port = [int]$BackendStatus.Backend.Port
            Version = $BackendStatus.Backend.Version
            Ready = [bool]$BackendStatus.Backend.Ready
        }
        Tunnel = [PSCustomObject]@{
            Status = [string]$Tunnel.Status
            SSHPID = $Tunnel.SSHPID
            FRPCPID = $Tunnel.FRPCPID
        }
        HeartbeatAgent = [PSCustomObject]@{
            Status = [string]$Agent.Status
            PID = $Agent.PID
            LastAcceptedAt = $Agent.LastAcceptedAt
        }
        Supervisor = if ($null -ne $Supervisor) { [PSCustomObject]@{ Status = [string]$Supervisor.Status; PID = $Supervisor.PID; LastHealAt = $Supervisor.LastHealAt } } else { $null }
        MachineAuthorization = [PSCustomObject]@{
            Status = [string]$Authorization.Status
            MachineID = $Authorization.MachineID
            TargetID = $Authorization.TargetID
        }
        Warnings = @($warnings | Select-Object -Unique)
    }
    return [PSCustomObject]@{ Result = $result; ExitCode = $exitCode }
}

function Get-RelayOfflineAuthorizationView {
    # Stop and offline paths must not require the network: report only what the
    # persistent credential file proves, and never delete or rotate it.
    param([Parameter(Mandatory)][psobject]$MachineConfig)
    $credential = Read-RelayMachineCredentialSummary -MachineConfig $MachineConfig
    if ($null -eq $credential) { return [PSCustomObject]@{ Status = 'Missing'; MachineID = $null; TargetID = $null; Reason = 'credential_missing' } }
    return [PSCustomObject]@{ Status = 'Preserved'; MachineID = $credential.MachineID; TargetID = $credential.TargetID; Reason = $null }
}

function Resolve-RelayMachineAuthorization {
    # start/restart credential handling per spec 5.1: reuse a valid credential,
    # reauthorize on revoked/missing, and fail Degraded on network trouble without
    # discarding a possibly valid credential.
    param(
        [Parameter(Mandatory)][psobject]$Config,
        [Parameter(Mandatory)][psobject]$MachineConfig,
        [scriptblock]$AuthProvider
    )

    $status = Invoke-RelayMachineAuth -Config $Config -MachineConfig $MachineConfig -Action status -AuthProvider $AuthProvider
    if ($status.Status -eq 'Authorized') { return $status }
    if ($status.Status -eq 'Unavailable') { return $status }
    # Unauthorized (missing) or Revoked: run the browser device flow exactly once.
    return Invoke-RelayMachineAuth -Config $Config -MachineConfig $MachineConfig -Action ensure -AuthProvider $AuthProvider
}

function Invoke-RelayOrchestratedStatus {
    param(
        [Parameter(Mandatory)][psobject]$Config,
        [Parameter(Mandatory)][psobject]$MachineConfig,
        [hashtable]$Providers
    )

    $backend = Get-RelayStatus -Config $Config -ListenerProvider $Providers.ListenerProvider -ProcessProvider $Providers.ProcessProvider -ProbeProvider $Providers.ProbeProvider
    $tunnel = Get-RelayManagedTunnelStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
    $agent = Get-RelayMachineAgentStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
    $supervisor = Get-RelaySupervisorStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
    $auth = Invoke-RelayMachineAuth -Config $Config -MachineConfig $MachineConfig -Action status -AuthProvider $Providers.AuthProvider
    return ConvertTo-RelayAggregateResult -BackendStatus $backend -Tunnel $tunnel -Agent $agent -Authorization (ConvertTo-RelayMachineAuthorizationView -AuthResult $auth) -Supervisor $supervisor -Action status
}

function Invoke-RelayOrchestratedDoctor {
    param(
        [Parameter(Mandatory)][psobject]$Config,
        [Parameter(Mandatory)][psobject]$MachineConfig,
        [hashtable]$Providers,
        [hashtable]$UserEnvironment
    )

    $aggregate = Invoke-RelayOrchestratedStatus -Config $Config -MachineConfig $MachineConfig -Providers $Providers
    $coreDoctor = Get-RelayDoctorReport -Config $Config -UserEnvironment $UserEnvironment
    $result = $aggregate.Result
    $result | Add-Member -NotePropertyName BackendDoctor -NotePropertyValue $coreDoctor
    $result | Add-Member -NotePropertyName MachineFiles -NotePropertyValue ([PSCustomObject]@{
        Credential = if (Test-Path -LiteralPath $MachineConfig.CredentialPath -PathType Leaf) { 'Present' } else { 'Missing' }
        FrpcConfig = if (Test-Path -LiteralPath $MachineConfig.FrpcConfigPath -PathType Leaf) { 'Present' } else { 'Missing' }
        ConfigDir = [string]$MachineConfig.ConfigDir
        RelayOrigin = [string]$MachineConfig.RelayOrigin
    })
    return [PSCustomObject]@{ Result = $result; ExitCode = $aggregate.ExitCode }
}

function Invoke-RelayOrchestratedStart {
    param(
        [Parameter(Mandatory)][psobject]$Config,
        [Parameter(Mandatory)][psobject]$MachineConfig,
        [hashtable]$Providers,
        [int]$LifecycleTimeoutMs = 20000,
        [int]$PollMs = 200
    )

    $warnings = [Collections.Generic.List[string]]::new()

    # Fail closed on ownership problems before any authorization or mutation.
    $preflight = Get-RelayStatus -Config $Config -ListenerProvider $Providers.ListenerProvider -ProcessProvider $Providers.ProcessProvider -ProbeProvider $Providers.ProbeProvider
    if ([string]$preflight.State -in @('Foreign', 'Conflict')) {
        $offlineAuth = Get-RelayOfflineAuthorizationView -MachineConfig $MachineConfig
        $tunnelNow = Get-RelayManagedTunnelStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
        $agentNow = Get-RelayMachineAgentStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
        return ConvertTo-RelayAggregateResult -BackendStatus $preflight -Tunnel $tunnelNow -Agent $agentNow -Authorization $offlineAuth -Mutation -Action start
    }

    # Authorization before runtime components (spec 5.1 steps 1-3). Network or
    # relay failure keeps the stored credential and fails Degraded.
    $auth = Resolve-RelayMachineAuthorization -Config $Config -MachineConfig $MachineConfig -AuthProvider $Providers.AuthProvider
    if ($auth.Status -ne 'Authorized') {
        $reasonText = if ([string]::IsNullOrWhiteSpace([string]$auth.Reason)) { [string]$auth.Status } else { [string]$auth.Reason }
        $warnings.Add("Machine authorization did not complete: $reasonText. The stored credential was not modified.")
        $tunnelNow = Get-RelayManagedTunnelStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
        $agentNow = Get-RelayMachineAgentStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
        $aggregate = ConvertTo-RelayAggregateResult -BackendStatus $preflight -Tunnel $tunnelNow -Agent $agentNow -Authorization (ConvertTo-RelayMachineAuthorizationView -AuthResult $auth) -ExtraWarnings $warnings -Mutation -Action start
        if ($auth.ExitCode -eq 6) { return [PSCustomObject]@{ Result = $aggregate.Result; ExitCode = 6 } }
        return $aggregate
    }

    return Use-RelayMutex -Config $Config -TimeoutMs $LifecycleTimeoutMs -ScriptBlock {
        # Backend: idempotent ensure. A healthy managed backend is a no-op.
        try {
            $null = Start-RelayBackend -Config $Config -StartBackendProvider $Providers.StartBackendProvider -ListenerProvider $Providers.ListenerProvider -ProcessProvider $Providers.ProcessProvider -ProbeProvider $Providers.ProbeProvider -ReadyTimeoutMs $LifecycleTimeoutMs -PollMs $PollMs -AllowStaleRecovery
        }
        catch {
            $message = [string]$_.Exception.Message
            $backendNow = Get-RelayStatus -Config $Config -ListenerProvider $Providers.ListenerProvider -ProcessProvider $Providers.ProcessProvider -ProbeProvider $Providers.ProbeProvider
            $tunnelNow = Get-RelayManagedTunnelStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
            $agentNow = Get-RelayMachineAgentStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
            $warnings.Add((Get-RelaySafeLifecycleErrorText -Message $message))
            $aggregate = ConvertTo-RelayAggregateResult -BackendStatus $backendNow -Tunnel $tunnelNow -Agent $agentNow -Authorization (ConvertTo-RelayMachineAuthorizationView -AuthResult $auth) -ExtraWarnings $warnings -Mutation -Action start
            if ($message -match 'ownership conflict') { return [PSCustomObject]@{ Result = $aggregate.Result; ExitCode = 6 } }
            return $aggregate
        }

        # Tunnel and agent: converge only missing or unhealthy owned components.
        try { $null = Start-RelayManagedTunnel -Config $Config -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -DaemonProvider $Providers.DaemonProvider -SleepProvider $Providers.SleepProvider }
        catch { $warnings.Add("Tunnel start failed: $([string]$_.Exception.Message)") }
        try { $null = Start-RelayMachineAgent -Config $Config -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -DaemonProvider $Providers.DaemonProvider -SleepProvider $Providers.SleepProvider }
        catch { $warnings.Add("Heartbeat agent start failed: $([string]$_.Exception.Message)") }
        try { $null = Start-RelaySupervisor -Config $Config -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -DaemonProvider $Providers.DaemonProvider -SleepProvider $Providers.SleepProvider }
        catch { $warnings.Add("Tunnel supervisor start failed: $([string]$_.Exception.Message)") }

        $backendFinal = Get-RelayStatus -Config $Config -ListenerProvider $Providers.ListenerProvider -ProcessProvider $Providers.ProcessProvider -ProbeProvider $Providers.ProbeProvider
        $tunnelFinal = Get-RelayManagedTunnelStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
        $agentFinal = Get-RelayMachineAgentStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
        $supervisorFinal = Get-RelaySupervisorStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
        return ConvertTo-RelayAggregateResult -BackendStatus $backendFinal -Tunnel $tunnelFinal -Agent $agentFinal -Authorization (ConvertTo-RelayMachineAuthorizationView -AuthResult $auth) -Supervisor $supervisorFinal -ExtraWarnings $warnings -Mutation -Action start
    }
}

function Get-RelaySafeLifecycleErrorText {
    param([Parameter(Mandatory)][string]$Message)
    if ($Message -match 'ownership conflict') { return 'Backend ownership conflict; nothing was killed or adopted.' }
    if ($Message -match 'deadline') { return 'Backend lifecycle deadline expired.' }
    return 'Backend start did not complete.'
}

function Invoke-RelayOrchestratedRestart {
    param(
        [Parameter(Mandatory)][psobject]$Config,
        [Parameter(Mandatory)][psobject]$MachineConfig,
        [hashtable]$Providers,
        [int]$LifecycleTimeoutMs = 20000,
        [int]$PollMs = 200
    )

    $warnings = [Collections.Generic.List[string]]::new()
    $preflight = Get-RelayStatus -Config $Config -ListenerProvider $Providers.ListenerProvider -ProcessProvider $Providers.ProcessProvider -ProbeProvider $Providers.ProbeProvider
    if ([string]$preflight.State -in @('Foreign', 'Conflict')) {
        $tunnelNow = Get-RelayManagedTunnelStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
        $agentNow = Get-RelayMachineAgentStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
        return ConvertTo-RelayAggregateResult -BackendStatus $preflight -Tunnel $tunnelNow -Agent $agentNow -Authorization (Get-RelayOfflineAuthorizationView -MachineConfig $MachineConfig) -Mutation -Action restart
    }

    $auth = Resolve-RelayMachineAuthorization -Config $Config -MachineConfig $MachineConfig -AuthProvider $Providers.AuthProvider
    if ($auth.Status -ne 'Authorized') {
        $warnings.Add("Machine authorization did not complete: $([string]$auth.Reason). The stored credential was not modified.")
        $tunnelNow = Get-RelayManagedTunnelStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
        $agentNow = Get-RelayMachineAgentStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
        $aggregate = ConvertTo-RelayAggregateResult -BackendStatus $preflight -Tunnel $tunnelNow -Agent $agentNow -Authorization (ConvertTo-RelayMachineAuthorizationView -AuthResult $auth) -ExtraWarnings $warnings -Mutation -Action restart
        if ($auth.ExitCode -eq 6) { return [PSCustomObject]@{ Result = $aggregate.Result; ExitCode = 6 } }
        return $aggregate
    }

    return Use-RelayMutex -Config $Config -TimeoutMs $LifecycleTimeoutMs -ScriptBlock {
        $restartStartedUtc = [datetime]::UtcNow

        # Supervisor first: stop the resident watchdog so it cannot resurrect the
        # tunnel we are about to intentionally replace.
        $supervisorStop = Stop-RelaySupervisor -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -SleepProvider $Providers.SleepProvider
        foreach ($warning in @($supervisorStop.Warnings)) { $warnings.Add([string]$warning) }

        # Backend: intentional replacement when running (including identity-proven
        # Unhealthy, e.g. right after a credential rotation); convergent start when
        # stopped.
        try {
            if ([string]$preflight.State -in @('Ready', 'Unhealthy')) {
                $null = Restart-RelayBackend -Config $Config -TuiExitProvider $Providers.TuiExitProvider -ActiveSessionProvider $Providers.ActiveSessionProvider -AbortSessionProvider $Providers.AbortSessionProvider -StopProcessTreeProvider $Providers.StopProcessTreeProvider -StartBackendProvider $Providers.StartBackendProvider -SleepProvider $Providers.SleepProvider -ListenerProvider $Providers.ListenerProvider -ProcessProvider $Providers.ProcessProvider -ProbeProvider $Providers.ProbeProvider -PortFreeProvider $Providers.PortFreeProvider -LifecycleTimeoutMs $LifecycleTimeoutMs -PollMs $PollMs -NowProvider $Providers.NowProvider
            }
            else {
                $null = Start-RelayBackend -Config $Config -StartBackendProvider $Providers.StartBackendProvider -ListenerProvider $Providers.ListenerProvider -ProcessProvider $Providers.ProcessProvider -ProbeProvider $Providers.ProbeProvider -ReadyTimeoutMs $LifecycleTimeoutMs -PollMs $PollMs -AllowStaleRecovery
            }
        }
        catch {
            $message = [string]$_.Exception.Message
            $warnings.Add((Get-RelaySafeLifecycleErrorText -Message $message))
            if ($message -match 'ownership conflict') {
                $backendNow = Get-RelayStatus -Config $Config -ListenerProvider $Providers.ListenerProvider -ProcessProvider $Providers.ProcessProvider -ProbeProvider $Providers.ProbeProvider
                $tunnelNow = Get-RelayManagedTunnelStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
                $agentNow = Get-RelayMachineAgentStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
                $aggregate = ConvertTo-RelayAggregateResult -BackendStatus $backendNow -Tunnel $tunnelNow -Agent $agentNow -Authorization (ConvertTo-RelayMachineAuthorizationView -AuthResult $auth) -ExtraWarnings $warnings -Mutation -Action restart
                return [PSCustomObject]@{ Result = $aggregate.Result; ExitCode = 6 }
            }
        }

        # Tunnel and agent: intentional runtime replacement, preserving target/port.
        $tunnelStop = Stop-RelayManagedTunnel -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -SleepProvider $Providers.SleepProvider
        foreach ($warning in @($tunnelStop.Warnings)) { $warnings.Add([string]$warning) }
        try { $null = Start-RelayManagedTunnel -Config $Config -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -DaemonProvider $Providers.DaemonProvider -SleepProvider $Providers.SleepProvider }
        catch { $warnings.Add("Tunnel start failed: $([string]$_.Exception.Message)") }

        $agentStop = Stop-RelayMachineAgent -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -SleepProvider $Providers.SleepProvider
        foreach ($warning in @($agentStop.Warnings)) { $warnings.Add([string]$warning) }
        $agentStarted = $false
        try {
            $null = Start-RelayMachineAgent -Config $Config -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -DaemonProvider $Providers.DaemonProvider -SleepProvider $Providers.SleepProvider
            $agentStarted = $true
        }
        catch { $warnings.Add("Heartbeat agent start failed: $([string]$_.Exception.Message)") }

        # Spec 5.2.8: wait for one accepted running heartbeat before declaring Ready.
        if ($agentStarted) {
            $heartbeatDeadline = [datetime]::UtcNow.AddMilliseconds([Math]::Max($LifecycleTimeoutMs, 15000))
            $accepted = $false
            do {
                $agentView = Get-RelayMachineAgentStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
                $heartbeat = $agentView.Heartbeat
                if ($null -ne $heartbeat -and [string]$heartbeat.status -eq 'Ready' -and $null -ne $heartbeat.PSObject.Properties['updatedAt']) {
                    # The [ref] target must be strongly typed or the 4-argument
                    # TryParse overload fails to bind.
                    $updated = [datetime]::MinValue
                    $updatedText = ConvertTo-RelayMachineUtcText -Value $heartbeat.updatedAt
                    if ([datetime]::TryParse($updatedText, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$updated) -and $updated.ToUniversalTime() -ge $restartStartedUtc.AddSeconds(-1)) {
                        $accepted = $true
                        break
                    }
                }
                Get-RelayOrchestrationSleep -SleepProvider $Providers.SleepProvider -Milliseconds 500
            } while ([datetime]::UtcNow -lt $heartbeatDeadline)
            if (-not $accepted) { $warnings.Add('No accepted running heartbeat was observed after restart.') }
        }

        # Supervisor last: bring the resident watchdog back up for the new tunnel.
        try { $null = Start-RelaySupervisor -Config $Config -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -DaemonProvider $Providers.DaemonProvider -SleepProvider $Providers.SleepProvider }
        catch { $warnings.Add("Tunnel supervisor start failed: $([string]$_.Exception.Message)") }

        $backendFinal = Get-RelayStatus -Config $Config -ListenerProvider $Providers.ListenerProvider -ProcessProvider $Providers.ProcessProvider -ProbeProvider $Providers.ProbeProvider
        $tunnelFinal = Get-RelayManagedTunnelStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
        $agentFinal = Get-RelayMachineAgentStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
        $supervisorFinal = Get-RelaySupervisorStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
        return ConvertTo-RelayAggregateResult -BackendStatus $backendFinal -Tunnel $tunnelFinal -Agent $agentFinal -Authorization (ConvertTo-RelayMachineAuthorizationView -AuthResult $auth) -Supervisor $supervisorFinal -ExtraWarnings $warnings -Mutation -Action restart
    }
}

function Invoke-RelayOrchestratedStop {
    param(
        [Parameter(Mandatory)][psobject]$Config,
        [Parameter(Mandatory)][psobject]$MachineConfig,
        [hashtable]$Providers,
        [int]$LifecycleTimeoutMs = 20000,
        [int]$PollMs = 200
    )

    return Use-RelayMutex -Config $Config -TimeoutMs $LifecycleTimeoutMs -ScriptBlock {
        $warnings = [Collections.Generic.List[string]]::new()

        # Supervisor first: stop the resident watchdog before any component so it
        # cannot resurrect the tunnel we are intentionally stopping.
        $supervisorStop = Stop-RelaySupervisor -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -SleepProvider $Providers.SleepProvider
        foreach ($warning in @($supervisorStop.Warnings)) { $warnings.Add([string]$warning) }

        # Order per spec 5.3: agent first (it sends the final stopped heartbeat on
        # its own), then tunnel, then the backend. No network is required.
        $agentStop = Stop-RelayMachineAgent -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -SleepProvider $Providers.SleepProvider
        foreach ($warning in @($agentStop.Warnings)) { $warnings.Add([string]$warning) }
        $tunnelStop = Stop-RelayManagedTunnel -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -SleepProvider $Providers.SleepProvider
        foreach ($warning in @($tunnelStop.Warnings)) { $warnings.Add([string]$warning) }

        $backendStatus = Get-RelayStatus -Config $Config -ListenerProvider $Providers.ListenerProvider -ProcessProvider $Providers.ProcessProvider -ProbeProvider $Providers.ProbeProvider
        switch ([string]$backendStatus.State) {
            'Stopped' { }
            { $_ -in @('Ready', 'Unhealthy') } {
                try {
                    $null = Stop-RelayBackend -Config $Config -TuiExitProvider $Providers.TuiExitProvider -ActiveSessionProvider $Providers.ActiveSessionProvider -AbortSessionProvider $Providers.AbortSessionProvider -StopProcessTreeProvider $Providers.StopProcessTreeProvider -SleepProvider $Providers.SleepProvider -ListenerProvider $Providers.ListenerProvider -ProcessProvider $Providers.ProcessProvider -ProbeProvider $Providers.ProbeProvider -PortFreeProvider $Providers.PortFreeProvider -LifecycleTimeoutMs $LifecycleTimeoutMs -PollMs $PollMs -NowProvider $Providers.NowProvider
                }
                catch { $warnings.Add('Backend stop did not complete.') }
            }
            'Stale' {
                # The recorded backend process no longer exists and no listener holds
                # the port: converge the record to stopped without touching anything.
                $listener = Get-RelayListener -Port $Config.Port -ListenerProvider $Providers.ListenerProvider
                if ($listener.Status -eq 'Absent') {
                    $state = Read-RelayState -Config $Config
                    $generation = if ($null -ne $state) { [int]$state.generation } else { 0 }
                    Write-RelayState -Config $Config -State ([PSCustomObject]@{ schema = 1; state = 'STOPPED'; generation = $generation; backend = $null })
                    $warnings.Add('Stale backend state was converged to stopped; no process was touched.')
                }
                else { $warnings.Add('Backend state is stale while a listener occupies the port; nothing was touched.') }
            }
            default {
                # Foreign, Conflict, DEGRADED, Unhealthy: never kill or adopt.
                $warnings.Add("Backend is $($backendStatus.State); the listener was left untouched.")
            }
        }

        $backendFinal = Get-RelayStatus -Config $Config -ListenerProvider $Providers.ListenerProvider -ProcessProvider $Providers.ProcessProvider -ProbeProvider $Providers.ProbeProvider
        $tunnelFinal = Get-RelayManagedTunnelStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
        $agentFinal = Get-RelayMachineAgentStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
        $supervisorFinal = Get-RelaySupervisorStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
        return ConvertTo-RelayAggregateResult -BackendStatus $backendFinal -Tunnel $tunnelFinal -Agent $agentFinal -Authorization (Get-RelayOfflineAuthorizationView -MachineConfig $MachineConfig) -Supervisor $supervisorFinal -ExtraWarnings $warnings -Mutation -Action stop
    }
}

# --- Tunnel-target orchestration (spec section 2) --------------------------------

function ConvertTo-RelayTunnelTargetResult {
    param(
        [Parameter(Mandatory)][psobject]$Tunnel,
        [Parameter(Mandatory)][psobject]$Agent,
        [Parameter(Mandatory)][psobject]$Authorization,
        [psobject]$Supervisor = $null,
        [AllowEmptyCollection()][string[]]$ExtraWarnings = @(),
        [switch]$Mutation,
        [ValidateSet('start', 'stop', 'restart', 'status')][string]$Action = 'status'
    )

    $status = if ($Tunnel.Status -eq 'Running' -and $Agent.Status -eq 'Running' -and $Authorization.Status -in @('Authorized', 'Preserved')) { 'Ready' }
    elseif ($Tunnel.Status -eq 'Stopped' -and $Agent.Status -in @('Stopped', 'Stale')) { 'Stopped' }
    else { 'Degraded' }
    $exitCode = switch ($status) {
        'Ready' { 0 }
        'Stopped' { if ($Mutation -and $Action -eq 'stop') { 0 } elseif ($Mutation) { 7 } else { 3 } }
        default { 7 }
    }
    if ($Authorization.Status -eq 'Revoked') { $exitCode = 6 }
    $result = [PSCustomObject]@{
        Status = $status
        Tunnel = [PSCustomObject]@{ Status = [string]$Tunnel.Status; SSHPID = $Tunnel.SSHPID; FRPCPID = $Tunnel.FRPCPID }
        HeartbeatAgent = [PSCustomObject]@{ Status = [string]$Agent.Status; PID = $Agent.PID; LastAcceptedAt = $Agent.LastAcceptedAt }
        Supervisor = if ($null -ne $Supervisor) { [PSCustomObject]@{ Status = [string]$Supervisor.Status; PID = $Supervisor.PID; LastHealAt = $Supervisor.LastHealAt } } else { $null }
        MachineAuthorization = [PSCustomObject]@{ Status = [string]$Authorization.Status; MachineID = $Authorization.MachineID; TargetID = $Authorization.TargetID }
        Warnings = @($ExtraWarnings | Select-Object -Unique)
    }
    return [PSCustomObject]@{ Result = $result; ExitCode = $exitCode }
}

function Invoke-RelayTunnelTarget {
    param(
        [Parameter(Mandatory)][psobject]$Config,
        [Parameter(Mandatory)][psobject]$MachineConfig,
        [Parameter(Mandatory)][ValidateSet('start', 'status', 'restart', 'stop', 'doctor')][string]$Action,
        [hashtable]$Providers,
        [int]$LifecycleTimeoutMs = 20000
    )

    $warnings = [Collections.Generic.List[string]]::new()
    $normalizedAction = if ($Action -eq 'doctor') { 'status' } else { $Action }
    $authView = $null

    switch ($normalizedAction) {
        'start' {
            $auth = Resolve-RelayMachineAuthorization -Config $Config -MachineConfig $MachineConfig -AuthProvider $Providers.AuthProvider
            $authView = ConvertTo-RelayMachineAuthorizationView -AuthResult $auth
            if ($auth.Status -ne 'Authorized') { $warnings.Add("Machine authorization did not complete: $([string]$auth.Reason).") }
            else {
                # Serialize component mutations under the shared mutex so this
                # secondary surface can never race the resident supervisor's heal.
                $null = Use-RelayMutex -Config $Config -TimeoutMs $LifecycleTimeoutMs -ScriptBlock {
                    try { $null = Start-RelayManagedTunnel -Config $Config -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -DaemonProvider $Providers.DaemonProvider -SleepProvider $Providers.SleepProvider }
                    catch { $warnings.Add("Tunnel start failed: $([string]$_.Exception.Message)") }
                    try { $null = Start-RelayMachineAgent -Config $Config -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -DaemonProvider $Providers.DaemonProvider -SleepProvider $Providers.SleepProvider }
                    catch { $warnings.Add("Heartbeat agent start failed: $([string]$_.Exception.Message)") }
                    try { $null = Start-RelaySupervisor -Config $Config -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -DaemonProvider $Providers.DaemonProvider -SleepProvider $Providers.SleepProvider }
                    catch { $warnings.Add("Tunnel supervisor start failed: $([string]$_.Exception.Message)") }
                }
            }
        }
        'restart' {
            $auth = Resolve-RelayMachineAuthorization -Config $Config -MachineConfig $MachineConfig -AuthProvider $Providers.AuthProvider
            $authView = ConvertTo-RelayMachineAuthorizationView -AuthResult $auth
            if ($auth.Status -ne 'Authorized') { $warnings.Add("Machine authorization did not complete: $([string]$auth.Reason).") }
            else {
                # Serialize component mutations under the shared mutex so this
                # secondary surface can never race the resident supervisor's heal.
                $null = Use-RelayMutex -Config $Config -TimeoutMs $LifecycleTimeoutMs -ScriptBlock {
                    $supervisorStop = Stop-RelaySupervisor -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -SleepProvider $Providers.SleepProvider
                    foreach ($warning in @($supervisorStop.Warnings)) { $warnings.Add([string]$warning) }
                    $tunnelStop = Stop-RelayManagedTunnel -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -SleepProvider $Providers.SleepProvider
                    foreach ($warning in @($tunnelStop.Warnings)) { $warnings.Add([string]$warning) }
                    try { $null = Start-RelayManagedTunnel -Config $Config -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -DaemonProvider $Providers.DaemonProvider -SleepProvider $Providers.SleepProvider }
                    catch { $warnings.Add("Tunnel start failed: $([string]$_.Exception.Message)") }
                    $agentStop = Stop-RelayMachineAgent -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -SleepProvider $Providers.SleepProvider
                    foreach ($warning in @($agentStop.Warnings)) { $warnings.Add([string]$warning) }
                    try { $null = Start-RelayMachineAgent -Config $Config -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -DaemonProvider $Providers.DaemonProvider -SleepProvider $Providers.SleepProvider }
                    catch { $warnings.Add("Heartbeat agent start failed: $([string]$_.Exception.Message)") }
                    try { $null = Start-RelaySupervisor -Config $Config -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -DaemonProvider $Providers.DaemonProvider -SleepProvider $Providers.SleepProvider }
                    catch { $warnings.Add("Tunnel supervisor start failed: $([string]$_.Exception.Message)") }
                }
            }
        }
        'stop' {
            # Serialize component mutations under the shared mutex so this
            # secondary surface can never race the resident supervisor's heal.
            $null = Use-RelayMutex -Config $Config -TimeoutMs $LifecycleTimeoutMs -ScriptBlock {
                $supervisorStop = Stop-RelaySupervisor -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -SleepProvider $Providers.SleepProvider
                foreach ($warning in @($supervisorStop.Warnings)) { $warnings.Add([string]$warning) }
                $agentStop = Stop-RelayMachineAgent -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -SleepProvider $Providers.SleepProvider
                foreach ($warning in @($agentStop.Warnings)) { $warnings.Add([string]$warning) }
                $tunnelStop = Stop-RelayManagedTunnel -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider -SleepProvider $Providers.SleepProvider
                foreach ($warning in @($tunnelStop.Warnings)) { $warnings.Add([string]$warning) }
            }
            $authView = Get-RelayOfflineAuthorizationView -MachineConfig $MachineConfig
        }
        'status' {
            $auth = Invoke-RelayMachineAuth -Config $Config -MachineConfig $MachineConfig -Action status -AuthProvider $Providers.AuthProvider
            $authView = ConvertTo-RelayMachineAuthorizationView -AuthResult $auth
        }
    }

    $tunnel = Get-RelayManagedTunnelStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
    $agent = Get-RelayMachineAgentStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
    $supervisor = Get-RelaySupervisorStatus -MachineConfig $MachineConfig -ProcessProvider $Providers.ProcessProvider
    $mutation = $normalizedAction -in @('start', 'restart', 'stop')
    return ConvertTo-RelayTunnelTargetResult -Tunnel $tunnel -Agent $agent -Authorization $authView -Supervisor $supervisor -ExtraWarnings $warnings -Mutation:$mutation -Action $normalizedAction
}

Export-ModuleMember -Function Get-RelayMachineConfig, Read-RelayMachineCredentialSummary, Invoke-RelayMachineAuth, ConvertTo-RelayMachineAuthorizationView, Read-RelayMachineProcessState, Test-RelayMachineProcessIdentity, Get-RelayMachineAgentStatus, Start-RelayMachineAgent, Stop-RelayMachineAgent, Get-RelaySupervisorStatus, Start-RelaySupervisor, Stop-RelaySupervisor, Get-RelayManagedTunnelStatus, Start-RelayManagedTunnel, Stop-RelayManagedTunnel, Write-RelayMachineStateFile, Invoke-RelayOrchestratedStatus, Invoke-RelayOrchestratedDoctor, Invoke-RelayOrchestratedStart, Invoke-RelayOrchestratedRestart, Invoke-RelayOrchestratedStop, Invoke-RelayTunnelTarget, ConvertTo-RelayAggregateResult, Get-RelayOfflineAuthorizationView
