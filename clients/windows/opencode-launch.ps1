#Requires -Version 7.2
# PositionalBinding is off so pass-through tokens such as `-s` can never bind to
# the hidden test parameters; everything unbound flows into $Arguments.
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(DontShow)][psobject]$ConfigOverride,
    [Parameter(DontShow)][hashtable]$Providers,
    [Parameter(DontShow)][switch]$NoExit,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'opencode-relay-common.psm1') -Force -ErrorAction Stop -DisableNameChecking -WarningAction SilentlyContinue

function Get-RelayLaunchArguments {
    param([AllowNull()][AllowEmptyCollection()][string[]]$InputArguments)
    if ($null -eq $InputArguments) { $InputArguments = @() }
    $directory = (Get-Location).ProviderPath
    $local = $false
    $forward = [Collections.Generic.List[string]]::new()
    for ($index = 0; $index -lt @($InputArguments).Count; $index++) {
        $argument = [string]$InputArguments[$index]
        if ($argument -eq '--local') { $local = $true; continue }
        if ($argument -eq '--dir') {
            if ($index + 1 -ge @($InputArguments).Count) { throw '--dir requires a directory.' }
            $index++
            $directory = [string]$InputArguments[$index]
            continue
        }
        if ($argument -like '--dir=*') {
            $directory = $argument.Substring(6)
            continue
        }
        $forward.Add($argument)
    }
    return [PSCustomObject]@{ Directory=$directory; Local=$local; Forward=@($forward) }
}

function ConvertTo-RelayCmdArgument {
    param([AllowEmptyString()][string]$Value = '')
    if ($Value -eq '') { return '""' }
    if ($Value -match '[\s"]') { return '"' + ($Value -replace '"', '\"') + '"' }
    return $Value
}

function Start-RelayLaunchChild {
    param([Parameter(Mandatory)][psobject]$Config,[AllowEmptyCollection()][AllowNull()][string[]]$ChildArguments = @(),[switch]$InjectServerCredentials,[switch]$StripServerCredentials)
    if ($null -eq $ChildArguments) { $ChildArguments = @() }
    $realCommand = [string]$Config.RealOpenCode
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.UseShellExecute = $false
    if ($StripServerCredentials) {
        # --local children must not see the shared-server credentials (spec section 6).
        $null = $startInfo.Environment.Remove('OPENCODE_SERVER_USERNAME')
        $null = $startInfo.Environment.Remove('OPENCODE_SERVER_PASSWORD')
    }
    if ($InjectServerCredentials -and -not [string]::IsNullOrEmpty([string]$Config.Password)) {
        # The caller's shell may predate the User-scope credential setup (stale
        # environment). Attach children must authenticate, so inject the canonical
        # rehydrated credentials into the child environment explicitly. Never pass
        # them on the command line (visible to process listers).
        $startInfo.Environment['OPENCODE_SERVER_USERNAME'] = [string]$Config.Username
        $startInfo.Environment['OPENCODE_SERVER_PASSWORD'] = [string]$Config.Password
    }
    if ([IO.Path]::GetExtension($realCommand) -ieq '.cmd') {
        $startInfo.FileName = if ([string]::IsNullOrWhiteSpace($env:ComSpec)) { Join-Path $env:SystemRoot 'System32\cmd.exe' } else { $env:ComSpec }
        $argumentText = (@($ChildArguments | ForEach-Object { ConvertTo-RelayCmdArgument -Value ([string]$_) }) -join ' ')
        $startInfo.Arguments = ('/d /s /c ""{0}" {1}"' -f $realCommand, $argumentText)
    }
    else {
        $startInfo.FileName = $realCommand
        foreach ($argument in $ChildArguments) { $startInfo.ArgumentList.Add([string]$argument) }
    }
    return [Diagnostics.Process]::Start($startInfo)
}

$config = if ($null -ne $ConfigOverride) { $ConfigOverride } else { Get-RelayConfig }
$parsed = Get-RelayLaunchArguments -InputArguments $Arguments
$childArguments = if ($parsed.Local) { @($parsed.Forward) } else { @('attach', "http://$($config.Host):$($config.Port)", '--dir', [string]$parsed.Directory) + @($parsed.Forward) }
$exitCode = 0

if (-not $parsed.Local) {
    if ($null -eq $Providers) { $Providers = @{} }
    $probe = Invoke-RelayBackendProbe -Config $config
    if (-not $probe.Ready) {
        # Bare interactive launch owns only the local backend bootstrap. It never
        # waits for browser authorization and never starts an independent fallback
        # process; `opencode --local` is the explicit escape hatch (spec section 6).
        try {
            $null = Start-RelayBackend -Config $config -StartBackendProvider $Providers.StartBackendProvider -ListenerProvider $Providers.ListenerProvider -ProcessProvider $Providers.ProcessProvider -ProbeProvider $Providers.ProbeProvider
        }
        catch { }
        $probe = Invoke-RelayBackendProbe -Config $config
    }
    if (-not $probe.Ready) {
        $status = Get-RelayStatus -Config $config -ListenerProvider $Providers.ListenerProvider -ProcessProvider $Providers.ProcessProvider -ProbeProvider $Providers.ProbeProvider
        if ([string]$status.State -in @('Foreign', 'Conflict')) {
            [Console]::Error.WriteLine("Port $($config.Port) is owned by a process this controller does not manage. Nothing was killed or adopted.")
            [Console]::Error.WriteLine('Use `opencode --local` for an independent session, or free the port and retry.')
            if ($NoExit) { $global:LASTEXITCODE = 6; return } else { exit 6 }
        }
        [Console]::Error.WriteLine("OpenCode shared backend at $($config.Host):$($config.Port) is unavailable.")
        [Console]::Error.WriteLine('No independent process was started. Use `opencode --local` for the explicit escape hatch.')
        if ($NoExit) { $global:LASTEXITCODE = 7; return } else { exit 7 }
    }
}

$child = $null
$lease = $null
try {
    $isAttachLaunch = (@($childArguments).Count -gt 0 -and [string]$childArguments[0] -eq 'attach')
    $child = Start-RelayLaunchChild -Config $config -ChildArguments $childArguments -InjectServerCredentials:$isAttachLaunch -StripServerCredentials:$parsed.Local
    if (-not $parsed.Local -and $null -ne $probe -and $probe.Ready) {
        $state = Read-RelayState -Config $config
        if ($null -eq $state -or $state.state -ne 'READY') { throw 'Relay attach requires the current READY generation.' }
        # A short-lived attach can exit before the registration query reaches the
        # OS. It has no remaining process lifetime to lease; a live attach must
        # still register before waiting.
        if (-not $child.HasExited) {
            try {
                $lease = Register-RelayClientLease -Config $config -Pid $child.Id -Directory ([string]$parsed.Directory) -BackendGeneration ([int]$state.generation)
            }
            catch {
                $child.Refresh()
                if (-not $child.HasExited) { throw }
            }
        }
    }
    $child.WaitForExit()
    $exitCode = $child.ExitCode
}
finally {
    if ($null -ne $lease) { Unregister-RelayClientLease -Config $config -Pid ([int]$lease.pid) -CreationUtc ([string]$lease.createdUtc) | Out-Null }
    if ($null -ne $child) { $child.Dispose() }
}

if ($NoExit) { $global:LASTEXITCODE = $exitCode; return }
exit $exitCode
