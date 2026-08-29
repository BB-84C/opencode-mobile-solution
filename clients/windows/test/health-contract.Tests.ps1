#Requires -Version 7.2
$ErrorActionPreference = 'Stop'

$module = Join-Path $PSScriptRoot '..\opencode-relay-machine.psm1'
Import-Module $module -Force -DisableNameChecking -WarningAction SilentlyContinue

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -cne $Expected) { throw "$Message (expected '$Expected', got '$Actual')" }
}
function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }

$root = Join-Path $PSScriptRoot '.test-state'
if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
[IO.Directory]::CreateDirectory($root) | Out-Null
try {
    $tokens = $null
    $parseErrors = $null
    $serverAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\opencode-relay-server.ps1'), [ref]$tokens, [ref]$parseErrors)
    Assert-Equal @($parseErrors).Count 0 'controller script must parse'
    $convergenceParameter = @($serverAst.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'TunnelConvergenceTimeoutMs' })[0]
    Assert-True ($null -ne $convergenceParameter) 'controller exposes independent tunnel convergence timeout'
    Assert-Equal $convergenceParameter.DefaultValue.Extent.Text '90000' 'convergence default is 90 seconds'
    $rangeText = ($convergenceParameter.Attributes | Where-Object { $_.TypeName.Name -eq 'ValidateRange' }).Extent.Text
    Assert-Equal $rangeText '[ValidateRange(10000, 180000)]' 'convergence range is independent of lifecycle timeout'

    $now = [datetime]'2026-08-29T12:00:00Z'
    $machine = [PSCustomObject]@{
        FrpDirectHost = 'test.invalid'; FrpcStatePath = Join-Path $root 'frpc.json'; SshStatePath = Join-Path $root 'ssh.json'
        AgentStatusPath = Join-Path $root 'agent.json'; HeartbeatIntervalMs = 30000
        AgentStatePath = Join-Path $root 'agent-process.json'
        TunnelMutationSuppressionPath = Join-Path $root 'mutation-suppression.json'
    }
    $resolvedConfig = Get-RelayMachineConfig -Config ([PSCustomObject]@{ StateRoot = $root }) -UserEnvironment @{ OPENCODE_FRP_DIRECT_HOST = 'direct.example' }
    Assert-Equal $resolvedConfig.FrpDirectHost 'direct.example' 'direct FRP host is a User-scope machine knob'
    $record = [PSCustomObject]@{ schema = 1; process = [PSCustomObject]@{ pid = 101; createdUtc = '2026-08-29T11:59:00Z'; executable = 'C:\fake\frpc.exe' } }
    Write-RelayMachineStateFile -Path $machine.FrpcStatePath -Value $record
    $processProvider = { param($id) [PSCustomObject]@{ ProcessId = $id; CreationDate = [datetime]'2026-08-29T11:59:00Z'; ExecutablePath = 'C:\fake\frpc.exe'; ParentProcessId = 1 } }
    $writeAgent = {
        param($raw, $failures, $observed = $now)
        Write-RelayMachineStateFile -Path $machine.AgentStatusPath -Value ([PSCustomObject]@{
            relayStatusObservedAt = $observed.ToString('o')
            relayStatus = [PSCustomObject]@{ checkedAt = $observed.ToString('o'); publicProbeReachable = $raw; publicReachable = ($failures -lt 2); probeFailureCount = $failures; publicStatus = if ($raw) { 200 } else { $null } }
        })
    }

    & $writeAgent $true 0
    $running = Get-RelayManagedTunnelStatus -MachineConfig $machine -ProcessProvider $processProvider -NowProvider { $now }
    Assert-Equal $running.Status 'Running' 'fresh raw success must be Running'
    Assert-Equal $running.Reason 'running' 'running reason'
    Assert-Equal $running.RecoveryRequired $false 'running is not recoverable'

    & $writeAgent $false 1
    $first = Get-RelayManagedTunnelStatus -MachineConfig $machine -ProcessProvider $processProvider -NowProvider { $now }
    Assert-Equal $first.Status 'Degraded' 'first raw failure must be honest'
    Assert-Equal $first.Reason 'relay_probe_failed' 'first failure reason'
    Assert-Equal $first.RecoveryRequired $false 'first failure must not trigger healing'
    Assert-Equal (Test-RelaySupervisorHealEligibility -Tunnel $first -LastHealAt $null -Now $now) $false 'supervisor ignores one raw failure'
    $firstAggregate = ConvertTo-RelayAggregateResult -BackendStatus ([PSCustomObject]@{ State='Ready'; Warnings=@(); Generation=1; Backend=[PSCustomObject]@{ Status='Ready'; PID=1; Port=1; Version='test'; Ready=$true } }) -Tunnel $first -Agent ([PSCustomObject]@{ Status='Running'; PID=2; LastAcceptedAt=$now.ToString('o') }) -Authorization ([PSCustomObject]@{ Status='Authorized'; MachineID='m'; TargetID='t' })
    Assert-Equal $firstAggregate.Result.State 'Degraded' 'one raw failure prevents aggregate Ready'

    & $writeAgent $false 2
    $second = Get-RelayManagedTunnelStatus -MachineConfig $machine -ProcessProvider $processProvider -NowProvider { $now }
    Assert-Equal $second.RecoveryRequired $true 'second failure triggers recovery'
    Assert-Equal (Test-RelaySupervisorHealEligibility -Tunnel $second -LastHealAt $null -Now $now) $true 'second failure is supervisor-eligible'

    & $writeAgent $true 0 $now.AddSeconds(-91)
    $stale = Get-RelayManagedTunnelStatus -MachineConfig $machine -ProcessProvider $processProvider -NowProvider { $now }
    Assert-Equal $stale.Reason 'relay_status_stale' 'stale relay sample reason'

    Remove-Item -LiteralPath $machine.AgentStatusPath -Force
    $missing = Get-RelayManagedTunnelStatus -MachineConfig $machine -ProcessProvider $processProvider -NowProvider { $now }
    Assert-Equal $missing.Reason 'relay_status_missing' 'missing relay sample reason'

    $staleProcess = Get-RelayManagedTunnelStatus -MachineConfig $machine -ProcessProvider { param($id) [PSCustomObject]@{ ProcessId = $id; CreationDate = [datetime]'2026-08-29T11:58:00Z'; ExecutablePath = 'C:\fake\other.exe'; ParentProcessId = 1 } } -NowProvider { $now }
    Assert-Equal $staleProcess.Reason 'process_identity_stale' 'PID identity mismatch reason'
    Assert-Equal $staleProcess.RecoveryRequired $true 'stale process requires recovery'

    Remove-Item -LiteralPath $machine.FrpcStatePath -Force
    $absent = Get-RelayManagedTunnelStatus -MachineConfig $machine -ProcessProvider $processProvider -NowProvider { $now }
    Assert-Equal $absent.Reason 'process_absent' 'absent component reason'
    Assert-Equal $absent.RelayStatusObservedAt $null 'absent component has no relay observation'
    Assert-Equal (Test-RelaySupervisorHealEligibility -Tunnel $absent -LastHealAt $now -Now $now.AddSeconds(101)) $true 'component absence remains eligible after cooldown without relay observation'
    Assert-Equal (Test-RelaySupervisorHealEligibility -Tunnel $staleProcess -LastHealAt $now -Now $now.AddSeconds(101)) $true 'stale component remains eligible after cooldown without relay observation'

    # Convergence uses its independent bounded clock and returns its own reason.
    Write-RelayMachineStateFile -Path $machine.FrpcStatePath -Value $record
    & $writeAgent $false 1
    $script:clock = $now
    $timedOut = Wait-RelayTunnelConverged -MachineConfig $machine -ProcessProvider $processProvider -SleepProvider { param($ms) $script:clock = $script:clock.AddMilliseconds($ms) } -NowProvider { $script:clock } -TimeoutMs 10000 -PollMs 1000
    Assert-Equal $timedOut.Reason 'relay_probe_convergence_timeout' 'convergence timeout taxonomy'
    Assert-Equal $timedOut.Status 'Degraded' 'convergence timeout is degraded, not conflict'

    # Default MinValue must never underflow, and the deadline boundary gets a final success poll.
    & $writeAgent $true 0
    $script:clock = $now
    $alreadyConverged = Wait-RelayTunnelConverged -MachineConfig $machine -ProcessProvider $processProvider -SleepProvider { param($ms) $script:clock = $script:clock.AddMilliseconds($ms) } -NowProvider { $script:clock } -TimeoutMs 10000
    Assert-Equal $alreadyConverged.Status 'Running' 'MinValue convergence accepts an already-fresh sample without underflow'
    & $writeAgent $false 1
    $script:nowCalls = 0
    $finalPoll = Wait-RelayTunnelConverged -MachineConfig $machine -ProcessProvider $processProvider -SleepProvider { param($ms) } -NowProvider {
        $script:nowCalls += 1
        if ($script:nowCalls -ge 4) { & $writeAgent $true 0; return $now.AddSeconds(10) }
        if ($script:nowCalls -eq 3) { return $now.AddSeconds(10) }
        return $now
    } -TimeoutMs 10000 -PollMs 1000
    Assert-Equal $finalPoll.Status 'Running' 'final deadline poll accepts success'

    # Cooldown: one heal, none at 60-90 seconds, and only a post-90-second local sample after 100 seconds.
    $lastHeal = $now
    $candidate = [PSCustomObject]@{ RecoveryRequired = $true; Reason = 'relay_probe_failed'; Status = 'Degraded'; RelayStatusObservedAt = $now.AddSeconds(95).ToString('o'); Components = [PSCustomObject]@{} }
    Assert-Equal (Test-RelaySupervisorHealEligibility -Tunnel $candidate -LastHealAt $lastHeal -Now $now.AddSeconds(89)) $false '60-90 second window blocks reheal'
    Assert-Equal (Test-RelaySupervisorHealEligibility -Tunnel $candidate -LastHealAt $lastHeal -Now $now.AddSeconds(101)) $true 'new post-90-second sample permits heal after cooldown'
    $candidate.RelayStatusObservedAt = $now.AddSeconds(89).ToString('o')
    Assert-Equal (Test-RelaySupervisorHealEligibility -Tunnel $candidate -LastHealAt $lastHeal -Now $now.AddSeconds(101)) $false 'old sample cannot permit reheal'

    $healCalls = 0
    foreach ($offset in @(0, 60, 89, 101)) {
        $sample = if ($offset -eq 101) { $now.AddSeconds(95) } else { $now.AddSeconds($offset) }
        $candidate.RelayStatusObservedAt = $sample.ToString('o')
        $priorHeal = if ($healCalls -eq 0) { $null } else { $lastHeal }
        if (Test-RelaySupervisorHealEligibility -Tunnel $candidate -LastHealAt $priorHeal -Now $now.AddSeconds($offset)) { $healCalls += 1 }
    }
    Assert-Equal $healCalls 2 'fake supervisor heals once initially and once only after cooldown plus new sample'
    Assert-Equal (Test-RelaySupervisorHealEligibility -Tunnel $candidate -LastHealAt 'corrupt-date' -Now $now.AddSeconds(1)) $true 'corrupt lastHealAt fails open for an eligible failure'

    # A dead heartbeat agent is independently recoverable even when the tunnel's relay sample is stale.
    Write-RelayMachineStateFile -Path $machine.AgentStatePath -Value ([PSCustomObject]@{ schema=1; process=[PSCustomObject]@{ pid=202; createdUtc='2026-08-29T11:59:00Z'; executable='C:\fake\node.exe' } })
    $deadAgent = Get-RelayMachineAgentStatus -MachineConfig $machine -ProcessProvider { param($id) if ($id -eq 202) { return $null }; & $processProvider $id }
    Assert-Equal $deadAgent.Status 'Stale' 'dead agent is observed through real process-state logic'
    $staleTunnel = [PSCustomObject]@{ Status = 'Degraded'; Reason = 'relay_status_stale'; RecoveryRequired = $false; RelayStatusObservedAt = $null; Components = [PSCustomObject]@{ Ssh = [PSCustomObject]@{ Status='Skipped' }; Frpc = [PSCustomObject]@{ Status='Running' } } }
    $agentDecision = Get-RelaySupervisorRecoveryDecision -Tunnel $staleTunnel -Agent $deadAgent -LastHealAt $now -Now $now.AddSeconds(101)
    Assert-Equal $agentDecision.Eligible $true 'dead agent remains eligible after cooldown without relay observation'
    Assert-Equal $agentDecision.StartAgent $true 'dead agent is converged by supervisor'
    Assert-Equal $agentDecision.RestartTunnel $false 'agent-only death does not tear down a healthy tunnel process'

    # A status exception produces an empty invalid snapshot, never a prior tunnel object.
    $statusSnapshot = Get-RelaySupervisorHealthSnapshot -TunnelStatusProvider { throw 'simulated status exception' } -AgentStatusProvider { [PSCustomObject]@{ Status='Running' } }
    Assert-Equal $statusSnapshot.Valid $false 'status exception invalidates supervisor snapshot'
    Assert-Equal $statusSnapshot.Tunnel $null 'status exception cannot reuse a stale tunnel object'

    # User mutation suppresses supervisor repair for the bounded convergence window.
    Set-RelayTunnelMutationSuppression -MachineConfig $machine -DurationMs 90000 -NowProvider { $now }
    Assert-Equal (Test-RelayTunnelMutationSuppressed -MachineConfig $machine -Now $now.AddSeconds(89)) $true 'mutation suppression remains active during convergence'
    Assert-Equal (Test-RelayTunnelMutationSuppressed -MachineConfig $machine -Now $now.AddSeconds(90)) $false 'mutation suppression expires at convergence deadline'
    $suppressedDecision = Get-RelaySupervisorRecoveryDecision -Tunnel $candidate -Agent ([PSCustomObject]@{ Status='Running' }) -LastHealAt $null -Now $now -MutationSuppressed $true
    Assert-Equal $suppressedDecision.Eligible $false 'supervisor honors mutation suppression marker'
    Clear-RelayTunnelMutationSuppression -MachineConfig $machine

    $aggregate = ConvertTo-RelayAggregateResult -BackendStatus ([PSCustomObject]@{ State='Ready'; Warnings=@(); Generation=1; Backend=[PSCustomObject]@{ Status='Ready'; PID=1; Port=1; Version='test'; Ready=$true } }) -Tunnel $second -Agent ([PSCustomObject]@{ Status='Running'; PID=2; LastAcceptedAt=$now.ToString('o') }) -Authorization ([PSCustomObject]@{ Status='Authorized'; MachineID='m'; TargetID='t' })
    Assert-Equal $aggregate.Result.Tunnel.Reason 'relay_probe_failed' 'aggregate preserves reason'
    Assert-Equal $aggregate.Result.Tunnel.RecoveryRequired $true 'aggregate preserves recovery flag'
    $target = ConvertTo-RelayTunnelTargetResult -Tunnel $second -Agent ([PSCustomObject]@{ Status='Running'; PID=2; LastAcceptedAt=$now.ToString('o') }) -Authorization ([PSCustomObject]@{ Status='Authorized'; MachineID='m'; TargetID='t' })
    Assert-Equal $target.Result.Tunnel.Reason 'relay_probe_failed' 'tunnel target preserves reason'
    Assert-Equal $target.Result.Tunnel.RecoveryRequired $true 'tunnel target preserves recovery flag'

    'health-contract.Tests.ps1: PASS'
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
