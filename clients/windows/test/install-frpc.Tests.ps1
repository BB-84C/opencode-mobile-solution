#Requires -Version 7.2
$ErrorActionPreference = 'Stop'

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -cne $Expected) { throw "$Message (expected '$Expected', got '$Actual')" }
}
function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }

$installer = Join-Path $PSScriptRoot '..\install-frpc.ps1'
$artifactRoot = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path '.opencode\artifacts\frp-permanent-recovery\windows-installer-tests'
[IO.Directory]::CreateDirectory($artifactRoot) | Out-Null

function New-Fixture([string]$Name) {
    $base = Join-Path $artifactRoot $Name
    if (Test-Path -LiteralPath $base) { Remove-Item -LiteralPath $base -Recurse -Force }
    [IO.Directory]::CreateDirectory($base) | Out-Null
    $root = Join-Path $base 'managed-frp'
    $config = Join-Path $base 'frpc.toml'
    [IO.File]::WriteAllText($config, 'serverAddr = "test.invalid"')
    $old = Join-Path $base 'legacy-frpc.exe'
    [IO.File]::WriteAllText($old, 'fake-frpc-0.69.1')
    return [PSCustomObject]@{ Root = $root; Config = $config; Old = $old }
}

function New-Providers($Fixture, [hashtable]$Options = @{}) {
    $global:FrpcTestEvents = [Collections.Generic.List[string]]::new()
    $global:FrpcTestUserValue = $Fixture.Old
    $global:FrpcTestRunningPath = $Fixture.Old
    $global:FrpcTestFixture = $Fixture
    $global:FrpcTestOptions = $Options
    $global:FrpcTestExpectedHash = '9e5062e3e5cf07e67144a3a4acf175ef6a2486f3605dd6cf288bae34ab39819f'
    return @{
        DownloadArchive = { param($url, $destination) $global:FrpcTestEvents.Add("download:$url") | Out-Null; [IO.File]::WriteAllText($destination, 'fake-archive') }
        ExtractArchive = { param($archive, $destination) $global:FrpcTestEvents.Add('extract') | Out-Null; $dir = Join-Path $destination 'frp_0.71.0_windows_amd64'; [IO.Directory]::CreateDirectory($dir) | Out-Null; [IO.File]::WriteAllText((Join-Path $dir 'frpc.exe'), 'fake-frpc-0.71.0') }
        GetHash = {
            param($path)
            $global:FrpcTestEvents.Add("hash:$([IO.Path]::GetFileName($path))") | Out-Null
            if ($global:FrpcTestOptions.BadHash -and $path -like '*.zip') { return ('0' * 64) }
            if ([IO.Path]::GetFileName($path) -eq 'frp_0.71.0_windows_amd64.zip') { return $global:FrpcTestExpectedHash }
            return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        GetVersion = {
            param($path)
            $global:FrpcTestEvents.Add("version:$([IO.Path]::GetFileName($path))") | Out-Null
            if ($global:FrpcTestOptions.BadVersion -and $path -like '*0.71.0*') { return '0.70.0' }
            $content = [IO.File]::ReadAllText($path)
            if ($content -match '0\.71\.0') { return '0.71.0' }
            if ($content -match '0\.69\.1') { return '0.69.1' }
            return 'unknown'
        }
        VerifyConfig = { param($path, $config) $global:FrpcTestEvents.Add("verify:$([IO.Path]::GetFileName($path))") | Out-Null; return (-not $global:FrpcTestOptions.BadConfig) }
        GetUserEnvironment = { param($name) $global:FrpcTestEvents.Add("env-get:$name") | Out-Null; return $global:FrpcTestUserValue }
        SetUserEnvironment = { param($name, $value) $global:FrpcTestEvents.Add("env-set:$value") | Out-Null; $global:FrpcTestUserValue = $value }
        CopyFile = { param($source, $destination) $global:FrpcTestEvents.Add("copy:$([IO.Path]::GetFileName($destination))") | Out-Null; Copy-Item -LiteralPath $source -Destination $destination -Force }
        InvokeController = {
            param($action, $target)
            $global:FrpcTestEvents.Add("controller:${action}:$target") | Out-Null
            if ($target -eq 'backend') { throw 'backend target must never be invoked' }
            if ($target -eq 'relay') {
                return [PSCustomObject]@{ ExitCode = 7; Payload = [PSCustomObject]@{ State = $global:FrpcTestOptions.BackendState } }
            }
            if ($action -eq 'stop') {
                $payload = [PSCustomObject]@{
                    Status = $(if ($global:FrpcTestOptions.StopDegraded) { 'Degraded' } else { 'Stopped' })
                    Tunnel = [PSCustomObject]@{ Status = $(if ($global:FrpcTestOptions.StopDegraded) { 'Degraded' } else { 'Stopped' }); FRPCPID = $null }
                    HeartbeatAgent = [PSCustomObject]@{ Status = 'Stopped' }
                    MachineAuthorization = [PSCustomObject]@{ Status = 'Preserved' }
                }
                return [PSCustomObject]@{ ExitCode = $(if ($global:FrpcTestOptions.StopDegraded) { 7 } else { 0 }); Payload = $payload }
            }
            if ($action -eq 'start') {
                if (($global:FrpcTestOptions.StartFails -and $global:FrpcTestUserValue -like '*0.71.0*') -or $global:FrpcTestOptions.RollbackStartFails) {
                    return [PSCustomObject]@{ ExitCode = 7; Payload = [PSCustomObject]@{ Status = 'Degraded' } }
                }
                $global:FrpcTestRunningPath = $global:FrpcTestUserValue
                return [PSCustomObject]@{ ExitCode = 0; Payload = [PSCustomObject]@{ Status = 'Ready' } }
            }
            $isCandidate = $global:FrpcTestUserValue -like '*0.71.0*'
            $frpcPid = if ($global:FrpcTestOptions.WrongTunnelPid -and $isCandidate) { 123 } else { 991 }
            $payload = [PSCustomObject]@{
                Status = $(if ($global:FrpcTestOptions.TunnelStatusFails -and $isCandidate) { 'Degraded' } else { 'Ready' })
                Tunnel = [PSCustomObject]@{ Status = 'Running'; FRPCPID = $frpcPid }
                HeartbeatAgent = [PSCustomObject]@{ Status = $(if ($global:FrpcTestOptions.AgentStopped -and $isCandidate) { 'Stopped' } else { 'Running' }) }
                MachineAuthorization = [PSCustomObject]@{ Status = $(if ($global:FrpcTestOptions.AuthRevoked -and $isCandidate) { 'Revoked' } else { 'Authorized' }) }
            }
            return [PSCustomObject]@{ ExitCode = 0; Payload = $payload }
        }
        GetRunningFrpc = {
            param($statePath)
            $global:FrpcTestEvents.Add('process-readback') | Out-Null
            if ($global:FrpcTestOptions.WrongRunningPath -and $global:FrpcTestUserValue -like '*0.71.0*') { return [PSCustomObject]@{ PID = 991; ExecutablePath = $global:FrpcTestFixture.Old } }
            return [PSCustomObject]@{ PID = 991; ExecutablePath = $global:FrpcTestRunningPath }
        }
        AcquireLock = {
            param($path)
            try { return [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
            catch [IO.IOException] { throw '[SAFETY] Another FRPC installer mutation holds the lock.' }
        }
    }
}

function Invoke-TestInstaller($Fixture, [string]$Action, [hashtable]$Providers) {
    return & $installer -Action $Action -TestMode -TestRoot $Fixture.Root -TestConfigPath $Fixture.Config -Providers $Providers
}

try {
    Assert-True (Test-Path -LiteralPath $installer -PathType Leaf) 'installer script must exist'

    $stageFixture = New-Fixture 'stage'
    $stageProviders = New-Providers $stageFixture
    $beforeUser = $global:FrpcTestUserValue
    $stage = Invoke-TestInstaller $stageFixture 'stage' $stageProviders
    Assert-Equal $stage.ExitCode 0 "stage succeeds: $($stage.Message)"
    Assert-Equal $stage.State 'Staged' 'stage state'
    Assert-Equal $global:FrpcTestUserValue $beforeUser 'stage does not mutate User environment'
    Assert-Equal @($global:FrpcTestEvents | Where-Object { $_ -like 'controller:*' }).Count 0 'stage does not invoke controller'
    Assert-True (Test-Path -LiteralPath (Join-Path $stageFixture.Root 'staging\0.71.0\frpc.exe')) 'stage preserves verified candidate'

    foreach ($case in @(
        @{ Name = 'wrong-hash'; Options = @{ BadHash = $true } },
        @{ Name = 'wrong-version'; Options = @{ BadVersion = $true } },
        @{ Name = 'wrong-config'; Options = @{ BadConfig = $true } }
    )) {
        $fixture = New-Fixture $case.Name
        $providers = New-Providers $fixture $case.Options
        $result = Invoke-TestInstaller $fixture 'stage' $providers
        Assert-Equal $result.ExitCode 22 "$($case.Name) fails closed as safety rejection"
        Assert-Equal @($global:FrpcTestEvents | Where-Object { $_ -like 'env-set:*' -or $_ -like 'controller:*' }).Count 0 "$($case.Name) does not mutate lifecycle"
    }

    $activationFixture = New-Fixture 'activate'
    $activationProviders = New-Providers $activationFixture @{ BackendState = 'Stopped' }
    $null = Invoke-TestInstaller $activationFixture 'stage' $activationProviders
    $global:FrpcTestEvents.Clear()
    $activated = Invoke-TestInstaller $activationFixture 'activate' $activationProviders
    Assert-Equal $activated.ExitCode 0 'activate succeeds'
    Assert-Equal $activated.State 'Activated' 'activate state'
    $stopIndex = $global:FrpcTestEvents.IndexOf('controller:stop:tunnel')
    $switchIndex = @($global:FrpcTestEvents | ForEach-Object -Begin { $i = -1 } -Process { $i += 1; if ($_ -like 'env-set:*0.71.0*') { $i } })[0]
    $startIndex = $global:FrpcTestEvents.IndexOf('controller:start:tunnel')
    Assert-True ($stopIndex -ge 0 -and $stopIndex -lt $switchIndex) 'controller stop precedes selection switch'
    Assert-True ($startIndex -gt $switchIndex) 'controller start follows selection switch'
    Assert-True ($global:FrpcTestEvents.Contains('controller:status:tunnel')) 'activation gates on independent tunnel-target status readback'
    Assert-Equal @($global:FrpcTestEvents | Where-Object { $_ -eq 'controller:status:relay' }).Count 0 'backend Stopped aggregate is not consulted for activation'
    Assert-True ($global:FrpcTestEvents.Contains('process-readback')) 'activation reads actual running process'
    Assert-Equal @($global:FrpcTestEvents | Where-Object { $_ -eq 'controller:stop:backend' -or $_ -eq 'controller:start:backend' -or $_ -eq 'controller:restart:backend' }).Count 0 'installer never invokes backend lifecycle target'
    Assert-True (Test-Path -LiteralPath (Join-Path $activationFixture.Root 'frpc-0.69.1.exe')) 'old binary is archived'
    Assert-True (Test-Path -LiteralPath (Join-Path $activationFixture.Root 'frpc-0.71.0.exe')) 'new binary is versioned'
    Assert-True (@($global:FrpcTestEvents | Where-Object { $_ -eq 'version:frpc-0.69.1.exe' }).Count -gt 0) 'archived rollback version is read back'
    Assert-True (@($global:FrpcTestEvents | Where-Object { $_ -eq 'hash:frpc-0.69.1.exe' }).Count -gt 0) 'archived rollback hash is read back'

    $global:FrpcTestEvents.Clear()
    $activatedAgain = Invoke-TestInstaller $activationFixture 'activate' $activationProviders
    Assert-Equal $activatedAgain.ExitCode 0 'already healthy v0.71.0 activation is idempotent'
    Assert-Equal $activatedAgain.Idempotent $true 'idempotent activation is explicit'
    Assert-Equal @($global:FrpcTestEvents | Where-Object { $_ -like 'controller:stop:*' -or $_ -like 'env-set:*' }).Count 0 'idempotent activation does not stop or switch'
    Assert-True ($global:FrpcTestEvents.Contains('controller:status:tunnel')) 'idempotent activation still gates on tunnel-target payload'

    $conflictFixture = New-Fixture 'backend-conflict'
    $conflictProviders = New-Providers $conflictFixture @{ BackendState = 'Conflict' }
    $null = Invoke-TestInstaller $conflictFixture 'stage' $conflictProviders
    $conflictActivated = Invoke-TestInstaller $conflictFixture 'activate' $conflictProviders
    Assert-Equal $conflictActivated.ExitCode 0 'backend Conflict aggregate does not block tunnel-only activation'
    Assert-Equal @($global:FrpcTestEvents | Where-Object { $_ -like 'controller:*:relay' }).Count 0 'activation never requests aggregate relay status'

    $failureFixture = New-Fixture 'automatic-rollback'
    $failureProviders = New-Providers $failureFixture @{ StartFails = $true }
    $null = Invoke-TestInstaller $failureFixture 'stage' $failureProviders
    $global:FrpcTestEvents.Clear()
    $rolledBack = Invoke-TestInstaller $failureFixture 'activate' $failureProviders
    Assert-Equal $rolledBack.ExitCode 20 'failed activation safely rolls back'
    Assert-Equal $rolledBack.State 'RolledBack' 'automatic rollback state'
    Assert-Equal $global:FrpcTestUserValue $failureFixture.Old 'automatic rollback restores old User selection'
    Assert-True (@($global:FrpcTestEvents | Where-Object { $_ -eq 'controller:start:tunnel' }).Count -eq 2) 'automatic rollback attempts candidate start then old start'

    $partialStopFixture = New-Fixture 'partial-stop-recovery'
    $partialStopProviders = New-Providers $partialStopFixture @{ StopDegraded = $true }
    $null = Invoke-TestInstaller $partialStopFixture 'stage' $partialStopProviders
    $partialStop = Invoke-TestInstaller $partialStopFixture 'activate' $partialStopProviders
    Assert-Equal $partialStop.ExitCode 20 'degraded stop return immediately enters verified recovery'
    Assert-Equal $global:FrpcTestUserValue $partialStopFixture.Old 'partial stop recovery restores old selection'
    Assert-True ($global:FrpcTestEvents.Contains('controller:start:tunnel')) 'partial stop recovery restarts the old tunnel'

    $recoveryFailureFixture = New-Fixture 'recovery-failure-facts'
    $recoveryFailureProviders = New-Providers $recoveryFailureFixture @{ StartFails = $true; RollbackStartFails = $true }
    $null = Invoke-TestInstaller $recoveryFailureFixture 'stage' $recoveryFailureProviders
    $recoveryFailure = Invoke-TestInstaller $recoveryFailureFixture 'activate' $recoveryFailureProviders
    Assert-Equal $recoveryFailure.ExitCode 21 'unconfirmed recovery uses recovery-failed exit code'
    Assert-Equal $recoveryFailure.ControllerTarget 'tunnel' 'recovery failure names the safe controller target'
    Assert-Equal $recoveryFailure.RestorePath $recoveryFailureFixture.Old 'recovery failure names the non-secret restore path'
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$recoveryFailure.FailedStep)) 'recovery failure names the failed step'
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$recoveryFailure.RequiredAction)) 'recovery failure provides an actionable next step'

    $manualProviders = New-Providers $activationFixture
    $global:FrpcTestUserValue = Join-Path $activationFixture.Root 'frpc-0.71.0.exe'
    $global:FrpcTestRunningPath = $global:FrpcTestUserValue
    $firstRollback = Invoke-TestInstaller $activationFixture 'rollback' $manualProviders
    Assert-Equal $firstRollback.ExitCode 20 'manual rollback uses rollback exit code'
    Assert-Equal $global:FrpcTestUserValue (Join-Path $activationFixture.Root 'frpc-0.69.1.exe') 'manual rollback selects verified old binary'
    $secondRollback = Invoke-TestInstaller $activationFixture 'rollback' $manualProviders
    Assert-Equal $secondRollback.ExitCode 20 'manual rollback is idempotent'
    Assert-Equal $secondRollback.State 'RolledBack' 'idempotent rollback remains truthful'
    Assert-True ($global:FrpcTestEvents.Contains('controller:status:tunnel')) 'manual rollback gates on tunnel-target payload'
    Assert-Equal @($global:FrpcTestEvents | Where-Object { $_ -like 'controller:*:relay' }).Count 0 'manual rollback never gates on aggregate relay state'

    $readbackFixture = New-Fixture 'bad-running-readback'
    $readbackProviders = New-Providers $readbackFixture @{ WrongRunningPath = $true }
    $null = Invoke-TestInstaller $readbackFixture 'stage' $readbackProviders
    $badReadback = Invoke-TestInstaller $readbackFixture 'activate' $readbackProviders
    Assert-Equal $badReadback.ExitCode 20 'wrong actual running path triggers safe rollback'

    $pidFixture = New-Fixture 'tunnel-pid-readback'
    $pidProviders = New-Providers $pidFixture @{ WrongTunnelPid = $true }
    $null = Invoke-TestInstaller $pidFixture 'stage' $pidProviders
    $badPid = Invoke-TestInstaller $pidFixture 'activate' $pidProviders
    Assert-Equal $badPid.ExitCode 20 'tunnel-target FRPC PID mismatch triggers safe rollback'

    $agentFixture = New-Fixture 'tunnel-agent-readback'
    $agentProviders = New-Providers $agentFixture @{ AgentStopped = $true }
    $null = Invoke-TestInstaller $agentFixture 'stage' $agentProviders
    $badAgent = Invoke-TestInstaller $agentFixture 'activate' $agentProviders
    Assert-Equal $badAgent.ExitCode 20 'tunnel-target heartbeat agent mismatch triggers safe rollback'

    $preexistingFixture = New-Fixture 'preexisting-root'
    [IO.Directory]::CreateDirectory($preexistingFixture.Root) | Out-Null
    $preexistingCurrent = Join-Path $preexistingFixture.Root 'frpc.exe'
    [IO.File]::WriteAllText($preexistingCurrent, 'fake-frpc-0.69.1')
    $preexistingFixture.Old = $preexistingCurrent
    $preexistingProviders = New-Providers $preexistingFixture
    $stageWithoutAdopt = Invoke-TestInstaller $preexistingFixture 'stage' $preexistingProviders
    Assert-Equal $stageWithoutAdopt.ExitCode 22 'stage never silently adopts a pre-existing root'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $preexistingFixture.Root '.frpc-root-v1'))) 'rejected stage does not write the root sentinel'
    $adopted = Invoke-TestInstaller $preexistingFixture 'adopt' $preexistingProviders
    Assert-Equal $adopted.ExitCode 0 'explicit adopt accepts a single configured v0.69.1 binary'
    Assert-Equal $adopted.State 'Adopted' 'adopt state'
    Assert-True (@($adopted.Contents) -contains 'frpc.exe') 'adopt reports inspected root contents'
    Assert-True (Test-Path -LiteralPath (Join-Path $preexistingFixture.Root '.frpc-root-v1')) 'adopt writes sentinel only after verification'
    Assert-Equal @($global:FrpcTestEvents | Where-Object { $_ -like 'download:*' -or $_ -like 'controller:*' }).Count 0 'adopt neither downloads nor controls lifecycle'

    $unsafeAdoptFixture = New-Fixture 'unsafe-adopt'
    [IO.Directory]::CreateDirectory($unsafeAdoptFixture.Root) | Out-Null
    $unsafeCurrent = Join-Path $unsafeAdoptFixture.Root 'frpc.exe'
    [IO.File]::WriteAllText($unsafeCurrent, 'fake-frpc-0.69.1')
    [IO.File]::WriteAllText((Join-Path $unsafeAdoptFixture.Root 'other.exe'), 'unmanaged')
    $unsafeAdoptFixture.Old = $unsafeCurrent
    $unsafeProviders = New-Providers $unsafeAdoptFixture
    $unsafeAdopt = Invoke-TestInstaller $unsafeAdoptFixture 'adopt' $unsafeProviders
    Assert-Equal $unsafeAdopt.ExitCode 22 'adopt refuses an unmanaged executable'
    Assert-True (@($unsafeAdopt.Contents) -contains 'other.exe') 'adopt rejection reports the unsafe content'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $unsafeAdoptFixture.Root '.frpc-root-v1'))) 'unsafe adopt never writes sentinel'

    $wrongAdoptFixture = New-Fixture 'wrong-version-adopt'
    [IO.Directory]::CreateDirectory($wrongAdoptFixture.Root) | Out-Null
    $wrongCurrent = Join-Path $wrongAdoptFixture.Root 'frpc.exe'
    [IO.File]::WriteAllText($wrongCurrent, 'fake-frpc-0.70.0')
    $wrongAdoptFixture.Old = $wrongCurrent
    $wrongProviders = New-Providers $wrongAdoptFixture
    $wrongAdopt = Invoke-TestInstaller $wrongAdoptFixture 'adopt' $wrongProviders
    Assert-Equal $wrongAdopt.ExitCode 22 'adopt requires actual v0.69.1 current binary'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $wrongAdoptFixture.Root '.frpc-root-v1'))) 'wrong-version adopt never writes sentinel'

    $guardFixture = New-Fixture 'path-guard'
    $guardProviders = New-Providers $guardFixture
    $guarded = & $installer -Action status -TestMode -TestRoot ([IO.Path]::GetPathRoot($guardFixture.Root)) -TestConfigPath $guardFixture.Config -Providers $guardProviders
    Assert-Equal $guarded.ExitCode 22 'shallow root is rejected'

    $sentinelFixture = New-Fixture 'sentinel-guard'
    $sentinelProviders = New-Providers $sentinelFixture
    $null = Invoke-TestInstaller $sentinelFixture 'stage' $sentinelProviders
    Remove-Item -LiteralPath (Join-Path $sentinelFixture.Root 'staging\0.71.0\.frpc-release-staging-v1') -Force
    $sentinelRejected = Invoke-TestInstaller $sentinelFixture 'stage' $sentinelProviders
    Assert-Equal $sentinelRejected.ExitCode 22 'recursive staging replacement requires its creation-time sentinel'
    Assert-True (Test-Path -LiteralPath (Join-Path $sentinelFixture.Root 'staging\0.71.0')) 'sentinel rejection leaves the unowned directory intact'

    $lockFixture = New-Fixture 'lock'
    $lockProviders = New-Providers $lockFixture
    $null = Invoke-TestInstaller $lockFixture 'stage' $lockProviders
    $lockPath = Join-Path $lockFixture.Root '.install-frpc.lock'
    Assert-True (Test-Path -LiteralPath $lockPath) 'lock file persists after handle disposal'
    $staleLock = Invoke-TestInstaller $lockFixture 'stage' $lockProviders
    Assert-Equal $staleLock.ExitCode 0 'persistent unlocked lock file never wedges later mutation'
    $heldLock = [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $locked = Invoke-TestInstaller $lockFixture 'stage' $lockProviders
    }
    finally { $heldLock.Dispose() }
    Assert-Equal $locked.ExitCode 22 'concurrent mutation lock fails closed'
    Assert-True (Test-Path -LiteralPath $lockPath) 'failed acquisition leaves persistent lock file intact'
    $afterRelease = Invoke-TestInstaller $lockFixture 'stage' $lockProviders
    Assert-Equal $afterRelease.ExitCode 0 'released exclusive handle allows the next mutation'

    $retargetFixture = New-Fixture 'retarget-guard'
    $retargetOutput = & (Get-Command pwsh).Source -NoProfile -File $installer -Action status -TestRoot $retargetFixture.Root -TestConfigPath $retargetFixture.Config -Json
    $retargetExit = $LASTEXITCODE
    $retargeted = $retargetOutput | ConvertFrom-Json
    Assert-Equal $retargetExit 22 'test paths cannot retarget production without explicit test mode'
    Assert-Equal $retargeted.State 'SafetyRejected' 'retarget rejection is explicit'

    $usageFixture = New-Fixture 'usage'
    $usage = & $installer -Action nonsense -TestMode -TestRoot $usageFixture.Root -TestConfigPath $usageFixture.Config -Providers (New-Providers $usageFixture)
    Assert-Equal $usage.ExitCode 64 'unsupported action has distinct usage exit code'

    $installerSource = [IO.File]::ReadAllText($installer)
    Assert-True ($installerSource -notmatch '\$env:LOCALAPPDATA|\$env:USERPROFILE') 'production roots use OS known-folder resolution rather than Process environment variables'

    'install-frpc.Tests.ps1: PASS'
}
finally {
    Remove-Item -LiteralPath $artifactRoot -Recurse -Force -ErrorAction SilentlyContinue
}
