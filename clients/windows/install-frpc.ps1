#Requires -Version 7.2
[CmdletBinding()]
param(
    [string]$Action = 'status',
    [switch]$Json,
    [Parameter(DontShow)][switch]$TestMode,
    [Parameter(DontShow)][string]$TestRoot,
    [Parameter(DontShow)][string]$TestConfigPath,
    [Parameter(DontShow)][hashtable]$Providers
)

$ErrorActionPreference = 'Stop'

$script:FrpVersion = '0.71.0'
$script:RollbackVersion = '0.69.1'
$script:ArchiveName = 'frp_0.71.0_windows_amd64.zip'
$script:ArchiveSha256 = '9e5062e3e5cf07e67144a3a4acf175ef6a2486f3605dd6cf288bae34ab39819f'
$script:ReleaseUrl = "https://github.com/fatedier/frp/releases/download/v$($script:FrpVersion)/$($script:ArchiveName)"
$script:ChecksumUrl = "https://github.com/fatedier/frp/releases/download/v$($script:FrpVersion)/frp_sha256_checksums.txt"
$script:ExitActivated = 0
$script:ExitRolledBack = 20
$script:ExitRecoveryFailed = 21
$script:ExitSafetyRejected = 22
$script:ExitUsage = 64

function New-FrpcResult {
    param(
        [Parameter(Mandatory)][string]$State,
        [Parameter(Mandatory)][int]$ExitCode,
        [string]$Message,
        [hashtable]$Details = @{}
    )
    $ordered = [ordered]@{
        Action = $Action
        State = $State
        ExitCode = $ExitCode
        Version = $script:FrpVersion
        Message = $Message
    }
    foreach ($key in $Details.Keys) { $ordered[$key] = $Details[$key] }
    return [PSCustomObject]$ordered
}

function Throw-FrpcFailure {
    param([ValidateSet('SAFETY','RECOVERY','USAGE')][string]$Kind, [string]$Message)
    throw "[$Kind] $Message"
}

function Get-FullPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { Throw-FrpcFailure SAFETY 'A required path was empty.' }
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Test-PathWithin([string]$Path, [string]$Root) {
    $fullPath = Get-FullPath $Path
    $fullRoot = Get-FullPath $Root
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    return $fullPath.Equals($fullRoot, $comparison) -or $fullPath.StartsWith($fullRoot + [IO.Path]::DirectorySeparatorChar, $comparison)
}

function Assert-SafeRoot([string]$Root) {
    $full = Get-FullPath $Root
    $driveRoot = [IO.Path]::GetPathRoot($full).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    if ($full.Equals($driveRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Throw-FrpcFailure SAFETY 'The FRP root cannot be a filesystem root.'
    }
    $relative = $full.Substring([IO.Path]::GetPathRoot($full).Length)
    $segments = @($relative -split '[\\/]' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($segments.Count -lt 3) { Throw-FrpcFailure SAFETY 'The FRP root is structurally too shallow.' }
    return $full
}

function Assert-ManagedRoot([psobject]$Context) {
    $root = Assert-SafeRoot $Context.Root
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { Throw-FrpcFailure SAFETY 'The managed FRP root does not exist; run stage first.' }
    if (-not (Test-Path -LiteralPath (Join-Path $root '.frpc-root-v1') -PathType Leaf)) {
        Throw-FrpcFailure SAFETY 'The managed FRP root sentinel is missing.'
    }
}

function Initialize-ManagedRoot([psobject]$Context) {
    $root = Assert-SafeRoot $Context.Root
    if (-not (Test-Path -LiteralPath $root)) {
        [IO.Directory]::CreateDirectory($root) | Out-Null
        [IO.File]::WriteAllText((Join-Path $root '.frpc-root-v1'), "created=$([datetime]::UtcNow.ToString('o'))")
    }
    Assert-ManagedRoot $Context
}

function Assert-ManagedChild([psobject]$Context, [string]$Path) {
    Assert-ManagedRoot $Context
    if (-not (Test-PathWithin -Path $Path -Root $Context.Root)) {
        Throw-FrpcFailure SAFETY 'A managed path escaped the FRP root.'
    }
}

function Initialize-SentinelDirectory([psobject]$Context, [string]$Path, [string]$Sentinel) {
    Assert-ManagedChild $Context $Path
    if (-not (Test-Path -LiteralPath $Path)) {
        [IO.Directory]::CreateDirectory($Path) | Out-Null
        [IO.File]::WriteAllText((Join-Path $Path $Sentinel), "created=$([datetime]::UtcNow.ToString('o'))")
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Path $Sentinel) -PathType Leaf)) {
        Throw-FrpcFailure SAFETY 'A managed directory sentinel is missing.'
    }
}

function Remove-SentinelDirectory([psobject]$Context, [string]$Path, [string]$Sentinel) {
    Assert-ManagedChild $Context $Path
    if (-not (Test-Path -LiteralPath $Path)) { return }
    if (-not (Test-Path -LiteralPath (Join-Path $Path $Sentinel) -PathType Leaf)) {
        Throw-FrpcFailure SAFETY 'Refusing recursive deletion without the expected sentinel.'
    }
    Remove-Item -LiteralPath $Path -Recurse -Force
}

function Write-ManagedJson([psobject]$Context, [string]$Path, $Value) {
    Assert-ManagedChild $Context $Path
    $temporary = "$Path.new"
    Assert-ManagedChild $Context $temporary
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Read-JsonFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return [IO.File]::ReadAllText($Path) | ConvertFrom-Json -ErrorAction Stop }
    catch { Throw-FrpcFailure SAFETY 'Managed metadata is unreadable.' }
}

function Invoke-CapturedProcess([string]$FilePath, [string[]]$Arguments) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $FilePath
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $null = $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) { return [PSCustomObject]@{ ExitCode = 1; Stdout = ''; Stderr = '' } }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return [PSCustomObject]@{ ExitCode = $process.ExitCode; Stdout = $stdout; Stderr = $stderr }
}

function New-DefaultProviders([psobject]$Context) {
    return @{
        DownloadArchive = {
            param($url, $destination)
            Invoke-WebRequest -Uri $url -OutFile $destination -MaximumRedirection 5 -ErrorAction Stop
        }
        ExtractArchive = { param($archive, $destination) Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }
        GetHash = { param($path) (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
        GetVersion = {
            param($path)
            $result = Invoke-CapturedProcess -FilePath $path -Arguments @('--version')
            if ($result.ExitCode -ne 0) { return $null }
            $match = [regex]::Match($result.Stdout + "`n" + $result.Stderr, '(?m)(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)')
            if ($match.Success) { return $match.Groups[1].Value }
            return $null
        }
        VerifyConfig = {
            param($path, $config)
            $result = Invoke-CapturedProcess -FilePath $path -Arguments @('verify', '-c', $config)
            return $result.ExitCode -eq 0
        }
        GetUserEnvironment = { param($name) [Environment]::GetEnvironmentVariable($name, 'User') }
        SetUserEnvironment = { param($name, $value) [Environment]::SetEnvironmentVariable($name, $value, 'User') }
        CopyFile = { param($source, $destination) Copy-Item -LiteralPath $source -Destination $destination -Force }
        InvokeController = {
            param($controllerAction, $target)
            $arguments = @('-NoProfile', '-NoLogo', '-File', $Context.ControllerPath, '-Action', $controllerAction, '-Target', $target, '-Json')
            $result = Invoke-CapturedProcess -FilePath (Get-Command pwsh -ErrorAction Stop).Source -Arguments $arguments
            $payload = $null
            if (-not [string]::IsNullOrWhiteSpace($result.Stdout)) {
                try {
                    $payload = $result.Stdout.Trim() | ConvertFrom-Json -ErrorAction Stop
                }
                catch { }
            }
            return [PSCustomObject]@{ ExitCode = [int]$result.ExitCode; Payload = $payload }
        }
        GetRunningFrpc = {
            param($statePath)
            $state = Read-JsonFile $statePath
            if ($null -eq $state -or $null -eq $state.process) { return $null }
            $processId = [int]$state.process.pid
            $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
            if ($null -eq $process) { return $null }
            $recordedPath = Get-FullPath ([string]$state.process.executable)
            $actualPath = Get-FullPath ([string]$process.ExecutablePath)
            if (-not $actualPath.Equals($recordedPath, [StringComparison]::OrdinalIgnoreCase)) { return $null }
            $recordedCreated = [datetime]::MinValue
            if (-not [datetime]::TryParse([string]$state.process.createdUtc, [ref]$recordedCreated)) { return $null }
            $actualCreated = if ($process.CreationDate -is [datetime]) {
                ([datetime]$process.CreationDate).ToUniversalTime()
            }
            else {
                ([Management.ManagementDateTimeConverter]::ToDateTime([string]$process.CreationDate)).ToUniversalTime()
            }
            if ([Math]::Abs(($actualCreated - $recordedCreated.ToUniversalTime()).TotalSeconds) -gt 2) { return $null }
            return [PSCustomObject]@{ PID = $processId; ExecutablePath = $actualPath }
        }
        AcquireLock = {
            param($path)
            if (Test-Path -LiteralPath $path) {
                $lockItem = Get-Item -LiteralPath $path -Force
                if ($lockItem.PSIsContainer -or ($lockItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                    Throw-FrpcFailure SAFETY 'The installer lock path is not a regular file.'
                }
            }
            try { return [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
            catch [IO.IOException] { Throw-FrpcFailure SAFETY 'Another FRPC installer mutation holds the lock.' }
        }
    }
}

function Get-Context {
    if ($TestMode) {
        if ([string]::IsNullOrWhiteSpace($TestRoot) -or [string]::IsNullOrWhiteSpace($TestConfigPath)) {
            Throw-FrpcFailure USAGE 'Test mode requires TestRoot and TestConfigPath.'
        }
        $root = Assert-SafeRoot $TestRoot
        $config = Get-FullPath $TestConfigPath
        $statePath = Join-Path ([IO.Path]::GetDirectoryName($root)) 'fake-tunnel-frpc-process.json'
    }
    else {
        if ($null -ne $Providers -or -not [string]::IsNullOrWhiteSpace($TestRoot) -or -not [string]::IsNullOrWhiteSpace($TestConfigPath)) {
            Throw-FrpcFailure SAFETY 'Test-only providers and paths require the explicit TestMode switch.'
        }
        $localApplicationData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
        $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
        if ([string]::IsNullOrWhiteSpace($localApplicationData) -or [string]::IsNullOrWhiteSpace($userProfile)) {
            Throw-FrpcFailure SAFETY 'Windows known-folder resolution failed.'
        }
        $root = Assert-SafeRoot (Join-Path $localApplicationData 'opencode-relay\frp')
        $configRoot = [Environment]::GetEnvironmentVariable('OPENCODE_RELAY_CONFIG_DIR', 'User')
        if ([string]::IsNullOrWhiteSpace($configRoot)) { $configRoot = Join-Path $userProfile '.config\opencode-relay' }
        $config = Get-FullPath (Join-Path $configRoot 'frpc.toml')
        $statePath = Get-FullPath (Join-Path $localApplicationData 'opencode-relay-server\tunnel-frpc-process.json')
    }
    return [PSCustomObject]@{
        Root = $root
        ConfigPath = $config
        StatePath = $statePath
        ControllerPath = Join-Path $PSScriptRoot 'opencode-relay-server.ps1'
        StageRoot = Join-Path $root 'staging\0.71.0'
        StageCandidate = Join-Path $root 'staging\0.71.0\frpc.exe'
        StageManifest = Join-Path $root 'staging\0.71.0\manifest.json'
        CandidatePath = Join-Path $root 'frpc-0.71.0.exe'
        RollbackPath = Join-Path $root 'frpc-0.69.1.exe'
        RollbackManifest = Join-Path $root 'rollback.json'
        SelectionPath = Join-Path $root 'selection.json'
        LockPath = Join-Path $root '.install-frpc.lock'
    }
}

function Assert-ProviderSet([hashtable]$ProviderSet) {
    foreach ($name in @('DownloadArchive','ExtractArchive','GetHash','GetVersion','VerifyConfig','GetUserEnvironment','SetUserEnvironment','CopyFile','InvokeController','GetRunningFrpc','AcquireLock')) {
        if (-not $ProviderSet.ContainsKey($name) -or $null -eq $ProviderSet[$name]) { Throw-FrpcFailure USAGE "Missing provider: $name" }
    }
}

function Get-VerifiedVersion([hashtable]$ProviderSet, [string]$Path, [string]$Expected) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Throw-FrpcFailure SAFETY 'A required FRPC binary is missing.' }
    $version = [string](& $ProviderSet.GetVersion $Path)
    if ($version -cne $Expected) { Throw-FrpcFailure SAFETY "FRPC version verification failed; expected $Expected." }
    return $version
}

function Get-VerifiedHash([hashtable]$ProviderSet, [string]$Path) {
    $hash = ([string](& $ProviderSet.GetHash $Path)).ToLowerInvariant()
    if ($hash -notmatch '^[0-9a-f]{64}$') { Throw-FrpcFailure SAFETY 'FRPC SHA256 readback was invalid.' }
    return $hash
}

function Assert-ConfigVerified([hashtable]$ProviderSet, [string]$Binary, [string]$Config) {
    if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) { Throw-FrpcFailure SAFETY 'The current frpc.toml is missing.' }
    if (-not (& $ProviderSet.VerifyConfig $Binary $Config)) { Throw-FrpcFailure SAFETY 'The candidate rejected the current frpc.toml.' }
}

function Invoke-Stage([psobject]$Context, [hashtable]$ProviderSet) {
    Initialize-ManagedRoot $Context
    $stagingParent = Join-Path $Context.Root 'staging'
    Initialize-SentinelDirectory $Context $stagingParent '.frpc-staging-v1'
    if (Test-Path -LiteralPath $Context.StageRoot) {
        Remove-SentinelDirectory $Context $Context.StageRoot '.frpc-release-staging-v1'
    }
    Initialize-SentinelDirectory $Context $Context.StageRoot '.frpc-release-staging-v1'
    $archive = Join-Path $Context.StageRoot $script:ArchiveName
    Assert-ManagedChild $Context $archive
    & $ProviderSet.DownloadArchive $script:ReleaseUrl $archive
    $archiveHash = Get-VerifiedHash $ProviderSet $archive
    if ($archiveHash -cne $script:ArchiveSha256) { Throw-FrpcFailure SAFETY 'The pinned FRPC archive SHA256 did not match.' }
    $extractRoot = Join-Path $Context.StageRoot 'extract'
    Initialize-SentinelDirectory $Context $extractRoot '.frpc-extract-v1'
    & $ProviderSet.ExtractArchive $archive $extractRoot
    $extracted = Join-Path $extractRoot 'frp_0.71.0_windows_amd64\frpc.exe'
    if (-not (Test-Path -LiteralPath $extracted -PathType Leaf)) { Throw-FrpcFailure SAFETY 'The pinned archive did not contain the expected frpc.exe.' }
    $null = Get-VerifiedVersion $ProviderSet $extracted $script:FrpVersion
    Assert-ConfigVerified $ProviderSet $extracted $Context.ConfigPath
    Assert-ManagedChild $Context $Context.StageCandidate
    & $ProviderSet.CopyFile $extracted $Context.StageCandidate
    $binaryHash = Get-VerifiedHash $ProviderSet $Context.StageCandidate
    $null = Get-VerifiedVersion $ProviderSet $Context.StageCandidate $script:FrpVersion
    Assert-ConfigVerified $ProviderSet $Context.StageCandidate $Context.ConfigPath
    Write-ManagedJson $Context $Context.StageManifest ([ordered]@{
        schema = 1; version = $script:FrpVersion; archive = $script:ArchiveName
        archiveSha256 = $archiveHash; binarySha256 = $binaryHash
        releaseUrl = $script:ReleaseUrl; checksumUrl = $script:ChecksumUrl
        configPath = $Context.ConfigPath; stagedAt = [datetime]::UtcNow.ToString('o')
    })
    return New-FrpcResult -State 'Staged' -ExitCode $script:ExitActivated -Message 'FRPC v0.71.0 is staged and verified.' -Details @{ ArchiveSha256 = $archiveHash; BinarySha256 = $binaryHash; StagedPath = $Context.StageCandidate }
}

function Get-StageEvidence([psobject]$Context, [hashtable]$ProviderSet) {
    Assert-ManagedRoot $Context
    $manifest = Read-JsonFile $Context.StageManifest
    if ($null -eq $manifest -or [string]$manifest.version -cne $script:FrpVersion -or [string]$manifest.archiveSha256 -cne $script:ArchiveSha256) {
        Throw-FrpcFailure SAFETY 'Verified v0.71.0 stage metadata is missing or inconsistent.'
    }
    $version = Get-VerifiedVersion $ProviderSet $Context.StageCandidate $script:FrpVersion
    $hash = Get-VerifiedHash $ProviderSet $Context.StageCandidate
    if ($hash -cne [string]$manifest.binarySha256) { Throw-FrpcFailure SAFETY 'The staged FRPC binary changed after verification.' }
    Assert-ConfigVerified $ProviderSet $Context.StageCandidate $Context.ConfigPath
    return [PSCustomObject]@{ Version = $version; Hash = $hash }
}

function Get-RunningEvidence([psobject]$Context, [hashtable]$ProviderSet, [string]$ExpectedVersion = $script:RollbackVersion) {
    $running = & $ProviderSet.GetRunningFrpc $Context.StatePath
    if ($null -eq $running -or [int]$running.PID -le 0 -or [string]::IsNullOrWhiteSpace([string]$running.ExecutablePath)) {
        Throw-FrpcFailure SAFETY 'The actual running FRPC process could not be identified.'
    }
    $path = Get-FullPath ([string]$running.ExecutablePath)
    $version = Get-VerifiedVersion $ProviderSet $path $ExpectedVersion
    $hash = Get-VerifiedHash $ProviderSet $path
    return [PSCustomObject]@{ PID = [int]$running.PID; Path = $path; Version = $version; Hash = $hash }
}

function Get-ControllerPayloadStatus($ControllerResult) {
    if ($null -eq $ControllerResult -or $null -eq $ControllerResult.Payload -or $null -eq $ControllerResult.Payload.PSObject.Properties['Status']) { return $null }
    return [string]$ControllerResult.Payload.Status
}

function Test-TunnelStopResult($ControllerResult) {
    if ($null -eq $ControllerResult -or [int]$ControllerResult.ExitCode -ne 0 -or (Get-ControllerPayloadStatus $ControllerResult) -ne 'Stopped') { return $false }
    return $null -ne $ControllerResult.Payload.Tunnel -and [string]$ControllerResult.Payload.Tunnel.Status -eq 'Stopped'
}

function Test-TunnelStartResult($ControllerResult) {
    return $null -ne $ControllerResult -and [int]$ControllerResult.ExitCode -eq 0 -and (Get-ControllerPayloadStatus $ControllerResult) -in @('Ready','Running')
}

function Test-TunnelReadback($ControllerResult, [int]$ExpectedFrpcPid) {
    if ($null -eq $ControllerResult -or [int]$ControllerResult.ExitCode -ne 0) { return $false }
    $payload = $ControllerResult.Payload
    if ($null -eq $payload -or [string]$payload.Status -ne 'Ready') { return $false }
    if ($null -eq $payload.Tunnel -or [string]$payload.Tunnel.Status -ne 'Running' -or [int]$payload.Tunnel.FRPCPID -ne $ExpectedFrpcPid) { return $false }
    if ($null -eq $payload.HeartbeatAgent -or [string]$payload.HeartbeatAgent.Status -ne 'Running') { return $false }
    if ($null -eq $payload.MachineAuthorization -or [string]$payload.MachineAuthorization.Status -notin @('Authorized','Preserved')) { return $false }
    return $true
}

function Get-AdoptContents([psobject]$Context) {
    if (-not (Test-Path -LiteralPath $Context.Root -PathType Container)) { return @() }
    return @(Get-ChildItem -LiteralPath $Context.Root -Force -Recurse | ForEach-Object {
        [IO.Path]::GetRelativePath($Context.Root, $_.FullName)
    } | Sort-Object)
}

function New-AdoptRejection([string]$Message, [string[]]$Contents) {
    return New-FrpcResult -State 'SafetyRejected' -ExitCode $script:ExitSafetyRejected -Message $Message -Details @{ Contents=@($Contents) }
}

function Invoke-Adopt([psobject]$Context, [hashtable]$ProviderSet) {
    $root = Assert-SafeRoot $Context.Root
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        return New-AdoptRejection 'The pre-existing FRP root does not exist; use stage for a new root.' @()
    }
    $contents = Get-AdoptContents $Context
    $sentinel = Join-Path $root '.frpc-root-v1'
    if (Test-Path -LiteralPath $sentinel -PathType Leaf) {
        return New-FrpcResult -State 'Adopted' -ExitCode $script:ExitActivated -Message 'The FRP root is already managed.' -Details @{ Contents=@($contents); Idempotent=$true }
    }

    $configured = [string](& $ProviderSet.GetUserEnvironment 'OPENCODE_FRPC_EXE')
    if ([string]::IsNullOrWhiteSpace($configured)) {
        return New-AdoptRejection 'Adopt requires an explicit User-scope OPENCODE_FRPC_EXE.' $contents
    }
    $configuredPath = Get-FullPath $configured
    if (-not (Test-PathWithin -Path $configuredPath -Root $root) -or -not (Test-Path -LiteralPath $configuredPath -PathType Leaf)) {
        return New-AdoptRejection 'The configured current FRPC must be an existing file inside the root being adopted.' $contents
    }

    $allowed = @(
        [IO.Path]::GetRelativePath($root, $configuredPath),
        [IO.Path]::GetRelativePath($root, $Context.LockPath)
    )
    $items = @(Get-ChildItem -LiteralPath $root -Force -Recurse)
    foreach ($item in $items) {
        $relative = [IO.Path]::GetRelativePath($root, $item.FullName)
        if ($relative -notin $allowed -or $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            return New-AdoptRejection 'The pre-existing FRP root contains unmanaged executable or unsafe content.' $contents
        }
    }

    try { $null = Get-VerifiedVersion $ProviderSet $configuredPath $script:RollbackVersion }
    catch { return New-AdoptRejection 'The configured current FRPC is not actual v0.69.1.' $contents }
    $hash = Get-VerifiedHash $ProviderSet $configuredPath
    [IO.File]::WriteAllText($sentinel, "created=$([datetime]::UtcNow.ToString('o'));adopted=true")
    Assert-ManagedRoot $Context
    return New-FrpcResult -State 'Adopted' -ExitCode $script:ExitActivated -Message 'The pre-existing v0.69.1 FRP root was inspected and adopted.' -Details @{ Contents=@($contents); CurrentPath=$configuredPath; CurrentVersion=$script:RollbackVersion; CurrentSha256=$hash; Idempotent=$false }
}

function Invoke-AutomaticRollback([psobject]$Context, [hashtable]$ProviderSet, [string]$OldUserValue, $OldEvidence) {
    $failedStep = 'verify-original-binary'
    $restorePath = if ([string]::IsNullOrWhiteSpace($OldUserValue)) { $null } else { Get-FullPath $OldUserValue }
    $startStatus = $null
    $readbackStatus = $null
    try {
        if ($null -ne $OldEvidence) {
            $restoreHash = Get-VerifiedHash $ProviderSet $restorePath
            $null = Get-VerifiedVersion $ProviderSet $restorePath $script:RollbackVersion
            if ($restoreHash -cne [string]$OldEvidence.Hash) { Throw-FrpcFailure RECOVERY 'The original rollback binary changed.' }
        }
        $failedStep = 'restore-user-selection'
        & $ProviderSet.SetUserEnvironment 'OPENCODE_FRPC_EXE' $OldUserValue
        $failedStep = 'restart-old-tunnel'
        $start = & $ProviderSet.InvokeController 'start' 'tunnel'
        $startStatus = Get-ControllerPayloadStatus $start
        if (-not (Test-TunnelStartResult $start)) { Throw-FrpcFailure RECOVERY 'The old tunnel did not restart.' }
        $failedStep = 'read-running-old-process'
        $running = & $ProviderSet.GetRunningFrpc $Context.StatePath
        if ($null -eq $running -or -not (Get-FullPath ([string]$running.ExecutablePath)).Equals($restorePath, [StringComparison]::OrdinalIgnoreCase)) {
            Throw-FrpcFailure RECOVERY 'The running rollback path did not match the restored User value.'
        }
        $null = Get-VerifiedVersion $ProviderSet $restorePath $script:RollbackVersion
        $failedStep = 'read-tunnel-target-status'
        $status = & $ProviderSet.InvokeController 'status' 'tunnel'
        $readbackStatus = Get-ControllerPayloadStatus $status
        if (-not (Test-TunnelReadback $status ([int]$running.PID))) { Throw-FrpcFailure RECOVERY 'Independent tunnel-target status did not confirm rollback.' }
        Write-ManagedJson $Context $Context.SelectionPath ([ordered]@{ schema=1; selectedVersion=$script:RollbackVersion; selectedPath=$restorePath; rollback='automatic'; updatedAt=[datetime]::UtcNow.ToString('o') })
        return New-FrpcResult -State 'RolledBack' -ExitCode $script:ExitRolledBack -Message 'Activation failed and the verified v0.69.1 selection was restored.' -Details @{ RunningPID = [int]$running.PID; RunningPath = $restorePath; ControllerStatus = $readbackStatus; ControllerTarget='tunnel' }
    }
    catch {
        return New-FrpcResult -State 'RecoveryFailed' -ExitCode $script:ExitRecoveryFailed -Message 'Activation failed and verified rollback could not be confirmed.' -Details @{
            FailedStep=$failedStep; RestorePath=$restorePath; RollbackArchivePath=$Context.RollbackPath
            ControllerTarget='tunnel'; TunnelStartStatus=$startStatus; TunnelReadbackStatus=$readbackStatus
            RequiredAction='Verify the named restore path and failed step, then run install-frpc.ps1 rollback -Json.'
        }
    }
}

function Invoke-Activate([psobject]$Context, [hashtable]$ProviderSet) {
    $oldUserValue = [string](& $ProviderSet.GetUserEnvironment 'OPENCODE_FRPC_EXE')
    if ([string]::IsNullOrWhiteSpace($oldUserValue)) { Throw-FrpcFailure SAFETY 'OPENCODE_FRPC_EXE must be explicitly set at User scope before activation.' }

    $currentRunning = & $ProviderSet.GetRunningFrpc $Context.StatePath
    if ($null -ne $currentRunning -and (Get-FullPath $oldUserValue).Equals((Get-FullPath $Context.CandidatePath), [StringComparison]::OrdinalIgnoreCase) -and (Get-FullPath ([string]$currentRunning.ExecutablePath)).Equals((Get-FullPath $Context.CandidatePath), [StringComparison]::OrdinalIgnoreCase)) {
        $currentHash = Get-VerifiedHash $ProviderSet $Context.CandidatePath
        $null = Get-VerifiedVersion $ProviderSet $Context.CandidatePath $script:FrpVersion
        Assert-ConfigVerified $ProviderSet $Context.CandidatePath $Context.ConfigPath
        $currentStatus = & $ProviderSet.InvokeController 'status' 'tunnel'
        if (Test-TunnelReadback $currentStatus ([int]$currentRunning.PID)) {
            return New-FrpcResult -State 'Activated' -ExitCode $script:ExitActivated -Message 'FRPC v0.71.0 is already selected and healthy.' -Details @{ RunningPID=[int]$currentRunning.PID; RunningPath=$Context.CandidatePath; BinarySha256=$currentHash; ControllerStatus=(Get-ControllerPayloadStatus $currentStatus); ControllerTarget='tunnel'; Idempotent=$true }
        }
        Throw-FrpcFailure SAFETY 'The selected v0.71.0 process is not healthy in tunnel-target status.'
    }

    $stage = Get-StageEvidence $Context $ProviderSet
    $oldEvidence = Get-RunningEvidence $Context $ProviderSet
    if (-not (Get-FullPath $oldUserValue).Equals($oldEvidence.Path, [StringComparison]::OrdinalIgnoreCase)) {
        Throw-FrpcFailure SAFETY 'The running FRPC path does not match the User-scope selection.'
    }
    $mutationStarted = $false
    try {
        $stop = & $ProviderSet.InvokeController 'stop' 'tunnel'
        $mutationStarted = $true
        if (-not (Test-TunnelStopResult $stop)) { Throw-FrpcFailure SAFETY 'Controller tunnel stop did not complete.' }
        $oldHashAfterStop = Get-VerifiedHash $ProviderSet $oldEvidence.Path
        $null = Get-VerifiedVersion $ProviderSet $oldEvidence.Path $script:RollbackVersion
        if ($oldHashAfterStop -cne $oldEvidence.Hash) { Throw-FrpcFailure SAFETY 'The old FRPC binary changed during shutdown.' }

        Assert-ManagedChild $Context $Context.RollbackPath
        & $ProviderSet.CopyFile $oldEvidence.Path $Context.RollbackPath
        $rollbackHash = Get-VerifiedHash $ProviderSet $Context.RollbackPath
        $null = Get-VerifiedVersion $ProviderSet $Context.RollbackPath $script:RollbackVersion
        if ($rollbackHash -cne $oldEvidence.Hash) { Throw-FrpcFailure SAFETY 'The archived rollback binary did not match the running old binary.' }
        Write-ManagedJson $Context $Context.RollbackManifest ([ordered]@{ schema=1; version=$script:RollbackVersion; sha256=$rollbackHash; previousUserValue=$oldUserValue; archivedAt=[datetime]::UtcNow.ToString('o') })

        Assert-ManagedChild $Context $Context.CandidatePath
        & $ProviderSet.CopyFile $Context.StageCandidate $Context.CandidatePath
        $candidateHash = Get-VerifiedHash $ProviderSet $Context.CandidatePath
        $null = Get-VerifiedVersion $ProviderSet $Context.CandidatePath $script:FrpVersion
        if ($candidateHash -cne $stage.Hash) { Throw-FrpcFailure SAFETY 'The installed v0.71.0 binary did not match the staged binary.' }
        Assert-ConfigVerified $ProviderSet $Context.CandidatePath $Context.ConfigPath

        & $ProviderSet.SetUserEnvironment 'OPENCODE_FRPC_EXE' $Context.CandidatePath
        $start = & $ProviderSet.InvokeController 'start' 'tunnel'
        if (-not (Test-TunnelStartResult $start)) { throw 'candidate tunnel start failed' }
        $running = & $ProviderSet.GetRunningFrpc $Context.StatePath
        if ($null -eq $running) { throw 'candidate process readback failed' }
        $runningPath = Get-FullPath ([string]$running.ExecutablePath)
        if (-not $runningPath.Equals((Get-FullPath $Context.CandidatePath), [StringComparison]::OrdinalIgnoreCase)) { throw 'candidate running path mismatch' }
        $null = Get-VerifiedVersion $ProviderSet $runningPath $script:FrpVersion
        $status = & $ProviderSet.InvokeController 'status' 'tunnel'
        if (-not (Test-TunnelReadback $status ([int]$running.PID))) { throw 'independent tunnel-target status failed' }
        Write-ManagedJson $Context $Context.SelectionPath ([ordered]@{ schema=1; selectedVersion=$script:FrpVersion; selectedPath=$Context.CandidatePath; updatedAt=[datetime]::UtcNow.ToString('o') })
        return New-FrpcResult -State 'Activated' -ExitCode $script:ExitActivated -Message 'FRPC v0.71.0 is selected and confirmed running.' -Details @{ RunningPID=[int]$running.PID; RunningPath=$runningPath; BinarySha256=$candidateHash; ControllerStatus=(Get-ControllerPayloadStatus $status); ControllerTarget='tunnel'; Idempotent=$false }
    }
    catch {
        if ($mutationStarted) { return Invoke-AutomaticRollback $Context $ProviderSet $oldUserValue $oldEvidence }
        throw
    }
}

function Get-RollbackEvidence([psobject]$Context, [hashtable]$ProviderSet) {
    Assert-ManagedRoot $Context
    $manifest = Read-JsonFile $Context.RollbackManifest
    if ($null -eq $manifest -or [string]$manifest.version -cne $script:RollbackVersion) { Throw-FrpcFailure SAFETY 'Verified v0.69.1 rollback metadata is missing.' }
    $hash = Get-VerifiedHash $ProviderSet $Context.RollbackPath
    $null = Get-VerifiedVersion $ProviderSet $Context.RollbackPath $script:RollbackVersion
    if ($hash -cne [string]$manifest.sha256) { Throw-FrpcFailure SAFETY 'The rollback binary changed after verification.' }
    return [PSCustomObject]@{ Hash=$hash; Manifest=$manifest }
}

function Invoke-Rollback([psobject]$Context, [hashtable]$ProviderSet) {
    $rollback = Get-RollbackEvidence $Context $ProviderSet
    $selected = [string](& $ProviderSet.GetUserEnvironment 'OPENCODE_FRPC_EXE')
    $running = & $ProviderSet.GetRunningFrpc $Context.StatePath
    if ($null -ne $running -and (Get-FullPath ([string]$running.ExecutablePath)).Equals((Get-FullPath $Context.RollbackPath), [StringComparison]::OrdinalIgnoreCase) -and (Get-FullPath $selected).Equals((Get-FullPath $Context.RollbackPath), [StringComparison]::OrdinalIgnoreCase)) {
        $null = Get-VerifiedVersion $ProviderSet $Context.RollbackPath $script:RollbackVersion
        $status = & $ProviderSet.InvokeController 'status' 'tunnel'
        if (Test-TunnelReadback $status ([int]$running.PID)) {
            return New-FrpcResult -State 'RolledBack' -ExitCode $script:ExitRolledBack -Message 'The verified v0.69.1 rollback is already selected and running.' -Details @{ RunningPID=[int]$running.PID; RunningPath=$Context.RollbackPath; BinarySha256=$rollback.Hash; ControllerStatus=(Get-ControllerPayloadStatus $status); ControllerTarget='tunnel'; Idempotent=$true }
        }
    }
    $stop = & $ProviderSet.InvokeController 'stop' 'tunnel'
    if (-not (Test-TunnelStopResult $stop)) {
        return New-FrpcResult -State 'RecoveryFailed' -ExitCode $script:ExitRecoveryFailed -Message 'Manual rollback could not safely pass the tunnel stop boundary.' -Details @{
            FailedStep='stop-tunnel'; RestorePath=$selected; RollbackArchivePath=$Context.RollbackPath
            ControllerTarget='tunnel'; TunnelStopStatus=(Get-ControllerPayloadStatus $stop); TunnelReadbackStatus=$null
            RequiredAction='Inspect tunnel-target status, restore the named selection if needed, then rerun install-frpc.ps1 rollback -Json.'
        }
    }
    $failedStep = 'select-rollback-binary'
    $startStatus = $null
    $readbackStatus = $null
    try {
        & $ProviderSet.SetUserEnvironment 'OPENCODE_FRPC_EXE' $Context.RollbackPath
        $failedStep = 'start-rollback-tunnel'
        $start = & $ProviderSet.InvokeController 'start' 'tunnel'
        $startStatus = Get-ControllerPayloadStatus $start
        if (-not (Test-TunnelStartResult $start)) { Throw-FrpcFailure RECOVERY 'The rollback tunnel did not start.' }
        $failedStep = 'read-running-rollback-process'
        $running = & $ProviderSet.GetRunningFrpc $Context.StatePath
        if ($null -eq $running -or -not (Get-FullPath ([string]$running.ExecutablePath)).Equals((Get-FullPath $Context.RollbackPath), [StringComparison]::OrdinalIgnoreCase)) { Throw-FrpcFailure RECOVERY 'The actual rollback process path was not confirmed.' }
        $null = Get-VerifiedVersion $ProviderSet $Context.RollbackPath $script:RollbackVersion
        $failedStep = 'read-tunnel-target-status'
        $status = & $ProviderSet.InvokeController 'status' 'tunnel'
        $readbackStatus = Get-ControllerPayloadStatus $status
        if (-not (Test-TunnelReadback $status ([int]$running.PID))) { Throw-FrpcFailure RECOVERY 'Independent tunnel-target status did not confirm rollback.' }
        Write-ManagedJson $Context $Context.SelectionPath ([ordered]@{ schema=1; selectedVersion=$script:RollbackVersion; selectedPath=$Context.RollbackPath; rollback='manual'; updatedAt=[datetime]::UtcNow.ToString('o') })
        return New-FrpcResult -State 'RolledBack' -ExitCode $script:ExitRolledBack -Message 'The verified v0.69.1 rollback is selected and running.' -Details @{ RunningPID=[int]$running.PID; RunningPath=$Context.RollbackPath; BinarySha256=$rollback.Hash; ControllerStatus=$readbackStatus; ControllerTarget='tunnel'; Idempotent=$false }
    }
    catch {
        return New-FrpcResult -State 'RecoveryFailed' -ExitCode $script:ExitRecoveryFailed -Message 'Manual rollback could not be confirmed.' -Details @{
            FailedStep=$failedStep; RestorePath=$Context.RollbackPath; RollbackArchivePath=$Context.RollbackPath
            ControllerTarget='tunnel'; TunnelStartStatus=$startStatus; TunnelReadbackStatus=$readbackStatus
            RequiredAction='Verify the rollback archive and failed step, then rerun install-frpc.ps1 rollback -Json.'
        }
    }
}

function Invoke-Status([psobject]$Context, [hashtable]$ProviderSet) {
    Assert-ManagedRoot $Context
    $selected = [string](& $ProviderSet.GetUserEnvironment 'OPENCODE_FRPC_EXE')
    $selectedVersion = $null
    $selectedHash = $null
    if (-not [string]::IsNullOrWhiteSpace($selected) -and (Test-Path -LiteralPath $selected -PathType Leaf)) {
        $selectedVersion = [string](& $ProviderSet.GetVersion $selected)
        $selectedHash = Get-VerifiedHash $ProviderSet $selected
    }
    $running = & $ProviderSet.GetRunningFrpc $Context.StatePath
    $runningVersion = $null
    if ($null -ne $running -and (Test-Path -LiteralPath ([string]$running.ExecutablePath) -PathType Leaf)) { $runningVersion = [string](& $ProviderSet.GetVersion ([string]$running.ExecutablePath)) }
    $controller = & $ProviderSet.InvokeController 'status' 'tunnel'
    $controllerStatus = Get-ControllerPayloadStatus $controller
    $state = if ($null -ne $running -and $runningVersion -in @($script:FrpVersion, $script:RollbackVersion) -and (Test-TunnelReadback $controller ([int]$running.PID))) { 'Running' } else { 'Degraded' }
    return New-FrpcResult -State $state -ExitCode $script:ExitActivated -Message 'FRPC installer status was read without mutation.' -Details @{
        SelectedPath=$selected; SelectedVersion=$selectedVersion; SelectedSha256=$selectedHash
        RunningPID=$(if ($null -ne $running) { [int]$running.PID } else { $null })
        RunningPath=$(if ($null -ne $running) { [string]$running.ExecutablePath } else { $null })
        RunningVersion=$runningVersion; ControllerStatus=$controllerStatus; ControllerTarget='tunnel'
        RollbackAvailable=(Test-Path -LiteralPath $Context.RollbackManifest -PathType Leaf)
    }
}

function Invoke-FrpcInstaller {
    $normalized = $Action.ToLowerInvariant()
    if ($normalized -notin @('adopt','stage','activate','rollback','status')) { Throw-FrpcFailure USAGE 'Usage: install-frpc.ps1 adopt|stage|activate|rollback|status [-Json]' }
    $context = Get-Context
    $providerSet = if ($TestMode) { $Providers } else { New-DefaultProviders $context }
    Assert-ProviderSet $providerSet
    if ($normalized -eq 'status') { return Invoke-Status $context $providerSet }
    if ($normalized -eq 'stage') { Initialize-ManagedRoot $context }
    elseif ($normalized -eq 'adopt') {
        $null = Assert-SafeRoot $context.Root
        if (-not (Test-Path -LiteralPath $context.Root -PathType Container)) {
            return New-AdoptRejection 'The pre-existing FRP root does not exist; use stage for a new root.' @()
        }
    }
    else { Assert-ManagedRoot $context }
    $lock = $null
    try {
        $lock = & $providerSet.AcquireLock $context.LockPath
        switch ($normalized) {
            'stage' { Invoke-Stage $context $providerSet }
            'adopt' { Invoke-Adopt $context $providerSet }
            'activate' { Invoke-Activate $context $providerSet }
            'rollback' { Invoke-Rollback $context $providerSet }
        }
    }
    finally {
        if ($null -ne $lock) {
            $lock.Dispose()
        }
    }
}

$result = try {
    Invoke-FrpcInstaller
}
catch {
    $message = [string]$_.Exception.Message
    if ($TestMode -and -not [string]::IsNullOrWhiteSpace([string]$_.ScriptStackTrace)) { $message += " | $($_.ScriptStackTrace)" }
    if ($message.StartsWith('[USAGE] ')) { New-FrpcResult -State 'UsageError' -ExitCode $script:ExitUsage -Message $message.Substring(8) }
    elseif ($message.StartsWith('[RECOVERY] ')) { New-FrpcResult -State 'RecoveryFailed' -ExitCode $script:ExitRecoveryFailed -Message $message.Substring(11) }
    else {
        $safeMessage = if ($message.StartsWith('[SAFETY] ')) { $message.Substring(9) } elseif ($TestMode) { $message } else { 'The operation failed closed before activation could be confirmed.' }
        New-FrpcResult -State 'SafetyRejected' -ExitCode $script:ExitSafetyRejected -Message $safeMessage
    }
}

if ($TestMode) { return $result }
if ($Json) { $result | ConvertTo-Json -Depth 8 -Compress }
else {
    Write-Output "FRPC installer: $($result.State)"
    Write-Output $result.Message
    foreach ($property in $result.PSObject.Properties | Where-Object { $_.Name -notin @('Action','State','ExitCode','Version','Message') }) {
        Write-Output "$($property.Name): $($property.Value)"
    }
}
exit ([int]$result.ExitCode)
