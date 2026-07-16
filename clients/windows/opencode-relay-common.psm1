#Requires -Version 7.2

function Get-UserEnvironmentValue {
    param(
        [Parameter(Mandatory)]
        [string]$Name
    )

    return [Environment]::GetEnvironmentVariable($Name, 'User')
}

function ConvertTo-DefinedRelayEnvironment {
    param(
        [Parameter(Mandatory)]
        [scriptblock]$ValueReader
    )

    $userEnvironment = @{}
    foreach ($name in @('OPENCODE_SERVER_PORT', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_TUNNEL_SCRIPT')) {
        $value = & $ValueReader $name
        if ($null -ne $value) {
            $userEnvironment[$name] = $value
        }
    }

    return $userEnvironment
}

function Get-RelayConfig {
    param(
        [hashtable]$UserEnvironment
    )

    if ($null -eq $UserEnvironment) {
        $UserEnvironment = ConvertTo-DefinedRelayEnvironment -ValueReader {
            param($name)
            Get-UserEnvironmentValue -Name $name
        }
    }

    $port = 4096
    if ($UserEnvironment.ContainsKey('OPENCODE_SERVER_PORT')) {
        $portText = [string]$UserEnvironment['OPENCODE_SERVER_PORT']
        $parsedPort = 0
        if (-not [int]::TryParse($portText, [ref]$parsedPort) -or $parsedPort -lt 1 -or $parsedPort -gt 65535) {
            throw 'OPENCODE_SERVER_PORT must be an integer from 1 through 65535.'
        }

        $port = $parsedPort
    }

    $username = 'opencode'
    if ($UserEnvironment.ContainsKey('OPENCODE_SERVER_USERNAME')) {
        $username = [string]$UserEnvironment['OPENCODE_SERVER_USERNAME']
    }

    $password = if ($UserEnvironment.ContainsKey('OPENCODE_SERVER_PASSWORD')) { [string]$UserEnvironment['OPENCODE_SERVER_PASSWORD'] } else { $null }
    if ([string]::IsNullOrWhiteSpace($password)) {
        throw 'OPENCODE_SERVER_PASSWORD must be set to a nonempty value.'
    }

    $tunnelScript = if ($UserEnvironment.ContainsKey('OPENCODE_TUNNEL_SCRIPT')) { [string]$UserEnvironment['OPENCODE_TUNNEL_SCRIPT'] } else { $null }
    $realOpenCode = [Environment]::GetEnvironmentVariable('OPENCODE_REAL_CMD', 'Process')
    if ([string]::IsNullOrWhiteSpace($realOpenCode)) {
        $realOpenCode = Join-Path $env:USERPROFILE 'AppData\Roaming\npm\opencode.cmd'
    }

    return [PSCustomObject]@{
        Host = '127.0.0.1'
        Port = [int]$port
        Username = $username
        Password = $password
        TunnelScript = $tunnelScript
        RealOpenCode = $realOpenCode
        StateRoot = Join-Path $env:LOCALAPPDATA 'opencode-relay-server'
    }
}

function Get-BasicHeader {
    param(
        [Parameter(Mandatory)]
        [psobject]$Config
    )

    $credentialBytes = [Text.Encoding]::UTF8.GetBytes("$($Config.Username):$($Config.Password)")
    return 'Basic ' + [Convert]::ToBase64String($credentialBytes)
}

function Invoke-RelayRequest {
    param(
        [Parameter(Mandatory)]
        [psobject]$Config,
        [Parameter(Mandatory)]
        [string]$Path
    )

    $client = [Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds(3)
    $request = $null
    $response = $null
    try {
        $uri = "http://$($Config.Host):$($Config.Port)$Path"
        $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $uri)
        $request.Headers.TryAddWithoutValidation('Authorization', (Get-BasicHeader -Config $Config)) | Out-Null
        $response = $client.Send($request)
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            return [PSCustomObject]@{
                Success = $false
                Body = $body
                Error = "Backend probe request failed with HTTP status $([int]$response.StatusCode)."
            }
        }

        return [PSCustomObject]@{
            Success = $true
            Body = $body
            Error = $null
        }
    }
    catch {
        return [PSCustomObject]@{
            Success = $false
            Body = $null
            Error = 'Backend probe request failed.'
        }
    }
    finally {
        if ($null -ne $response) {
            $response.Dispose()
        }
        if ($null -ne $request) {
            $request.Dispose()
        }
        $client.Dispose()
    }
}

function Invoke-RelayBackendProbe {
    param(
        [Parameter(Mandatory)]
        [psobject]$Config
    )

    $healthResult = Invoke-RelayRequest -Config $Config -Path '/global/health'
    $configResult = Invoke-RelayRequest -Config $Config -Path '/config'
    $version = $null
    $healthy = $false
    $healthError = $healthResult.Error

    if ($healthResult.Success) {
        try {
            $health = $healthResult.Body | ConvertFrom-Json -ErrorAction Stop
            $healthy = [bool]$health.healthy
            $version = $health.version
            if (-not $healthy) {
                $healthError = 'Backend health check reported unhealthy.'
            }
        }
        catch {
            $healthError = 'Backend health response was invalid.'
        }
    }

    $ready = $healthResult.Success -and $configResult.Success -and $healthy
    $probeError = if ($ready) { $null } elseif ($null -ne $healthError) { $healthError } else { $configResult.Error }
    return [PSCustomObject]@{
        Ready = [bool]$ready
        Version = $version
        Error = $probeError
    }
}

function ConvertTo-RelayUtcRoundTrip {
    param(
        [Parameter(Mandatory)]$Value
    )

    try {
        $dateTime = if ($Value -is [datetime]) {
            $Value
        }
        else {
            [datetime]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
        }
        return $dateTime.ToUniversalTime().ToString('o')
    }
    catch {
        throw 'Invalid relay state: backend createdUtc must be a round-trip UTC timestamp.'
    }
}

function Get-RelayNormalizedPath {
    param(
        [Parameter(Mandatory)][string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'Invalid relay state: backend executable is required.'
    }
    if (-not [IO.Path]::IsPathFullyQualified($Path)) {
        throw 'Invalid relay state: backend executable must be fully qualified.'
    }

    try {
        return [IO.Path]::GetFullPath($Path)
    }
    catch {
        throw 'Invalid relay state: backend executable must be an absolute path.'
    }
}

function ConvertTo-ValidatedRelayState {
    param(
        [Parameter(Mandatory)]$State
    )

    if ($null -eq $State -or $State.PSObject.Properties.Name -notcontains 'schema' -or [int]$State.schema -ne 1) {
        throw 'Invalid relay state: schema must be 1.'
    }
    if ($State.PSObject.Properties.Name -notcontains 'state' -or [string]::IsNullOrWhiteSpace([string]$State.state)) {
        throw 'Invalid relay state: state is required.'
    }
    if ($State.PSObject.Properties.Name -notcontains 'generation' -or [int]$State.generation -lt 0) {
        throw 'Invalid relay state: generation must be a nonnegative integer.'
    }
    if ($State.PSObject.Properties.Name -notcontains 'backend') {
        throw 'Invalid relay state: backend is required.'
    }
    if ($null -eq $State.backend) {
        if ([string]$State.state -notin @('STOPPED', 'DEGRADED')) { throw 'Invalid relay state: backend is required.' }
        return [PSCustomObject]@{ schema = 1; state = [string]$State.state; generation = [int]$State.generation; backend = $null; lastError = if ($State.PSObject.Properties.Name -contains 'lastError') { [string]$State.lastError } else { $null } }
    }

    $backend = $State.backend
    foreach ($field in @('pid', 'createdUtc', 'executable', 'port', 'version')) {
        if ($backend.PSObject.Properties.Name -notcontains $field) {
            throw "Invalid relay state: backend $field is required."
        }
    }
    if ($null -eq $backend.pid -or [int]$backend.pid -lt 1) {
        throw 'Invalid relay state: backend pid must be a positive integer.'
    }
    if ([int]$backend.port -lt 1 -or [int]$backend.port -gt 65535) {
        throw 'Invalid relay state: backend port must be an integer from 1 through 65535.'
    }
    if ([string]::IsNullOrWhiteSpace([string]$backend.version)) {
        throw 'Invalid relay state: backend version is required.'
    }

    return [PSCustomObject]@{
        schema = 1
        state = [string]$State.state
        generation = [int]$State.generation
        backend = [PSCustomObject]@{
            pid = [int]$backend.pid
            createdUtc = ConvertTo-RelayUtcRoundTrip -Value $backend.createdUtc
            executable = Get-RelayNormalizedPath -Path ([string]$backend.executable)
            parentPid = if ($backend.PSObject.Properties.Name -contains 'parentPid' -and $null -ne $backend.parentPid) { [int]$backend.parentPid } else { $null }
            port = [int]$backend.port
            version = [string]$backend.version
        }
        lastError = if ($State.PSObject.Properties.Name -contains 'lastError') { [string]$State.lastError } else { $null }
    }
}

function Read-RelayState {
    param(
        [Parameter(Mandatory)][psobject]$Config
    )

    $statePath = Join-Path $Config.StateRoot 'server-state.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        return $null
    }

    try {
        $raw = [IO.File]::ReadAllText($statePath, [Text.Encoding]::UTF8)
        $state = $raw | ConvertFrom-Json -ErrorAction Stop
        return ConvertTo-ValidatedRelayState -State $state
    }
    catch {
        if ($_.Exception.Message -like 'Invalid relay state:*') {
            throw $_.Exception
        }
        throw 'Invalid relay state: server-state.json could not be parsed.'
    }
}

function Write-RelayState {
    param(
        [Parameter(Mandatory)][psobject]$Config,
        [Parameter(Mandatory)][psobject]$State
    )

    $validatedState = ConvertTo-ValidatedRelayState -State $State
    $stateRoot = [string]$Config.StateRoot
    if ([string]::IsNullOrWhiteSpace($stateRoot)) {
        throw 'Relay state root is required.'
    }

    $statePath = Join-Path $stateRoot 'server-state.json'
    $temporaryPath = "$statePath.tmp"
    $stream = $null
    $writer = $null
    try {
        [IO.Directory]::CreateDirectory($stateRoot) | Out-Null
        $json = $validatedState | ConvertTo-Json -Depth 4 -Compress
        $stream = [IO.File]::Open($temporaryPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
        $writer.Write($json)
        $writer.Flush()
        $stream.Flush($true)
        $writer.Dispose()
        $writer = $null
        $stream.Dispose()
        $stream = $null

        if (Test-Path -LiteralPath $statePath -PathType Leaf) {
            [IO.File]::Move($temporaryPath, $statePath, $true)
        }
        else {
            [IO.File]::Move($temporaryPath, $statePath)
        }
    }
    catch {
        throw 'Relay state write failed.'
    }
    finally {
        if ($null -ne $writer) {
            $writer.Dispose()
        }
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-RelayListener {
    param(
        [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
        [scriptblock]$ListenerProvider
    )

    $connections = if ($null -ne $ListenerProvider) {
        # Injected providers stand in for the already-scoped NetTCP query.
        @(& $ListenerProvider $Port)
    }
    else {
        @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {
            [string]$_.LocalAddress -eq '127.0.0.1' -and [int]$_.LocalPort -eq $Port
        })
    }
    $pids = @($connections | ForEach-Object { [int]$_.OwningProcess } | Select-Object -Unique)
    $status = if ($connections.Count -eq 0) { 'Absent' } elseif ($connections.Count -eq 1 -and $pids.Count -eq 1 -and $pids[0] -gt 0) { 'Unique' } else { 'Conflict' }

    return [PSCustomObject]@{
        Status = $status
        PID = if ($status -eq 'Unique') { $pids[0] } else { $null }
        PIDs = $pids
        Connections = $connections
    }
}

function Get-RelayProcessInfo {
    param(
        [Parameter(Mandatory)][Alias('Pid')][ValidateRange(1, [int]::MaxValue)][int]$ProcessId,
        [scriptblock]$ProcessProvider
    )

    try {
        # Production identity comes from one Win32_Process snapshot. Get-Process
        # cannot prove the parent or command line belongs to the same process.
        $process = if ($null -ne $ProcessProvider) {
            & $ProcessProvider $ProcessId
        }
        else {
            Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        }
        if ($null -eq $process) {
            throw 'Process unavailable.'
        }
        $executablePath = if ($process.PSObject.Properties.Name -contains 'Path') { [string]$process.Path } else { [string]$process.ExecutablePath }
        $creation = if ($process.PSObject.Properties.Name -contains 'StartTime') { $process.StartTime } else { $process.CreationDate }
        $parentPid = if ($process.PSObject.Properties.Name -contains 'ParentProcessId') { [int]$process.ParentProcessId } elseif ($process.PSObject.Properties.Name -contains 'ParentId') { [int]$process.ParentId } else { $null }
        $commandLine = if ($process.PSObject.Properties.Name -contains 'CommandLine') { [string]$process.CommandLine } else { $null }
        $returnedPid = if ($process.PSObject.Properties.Name -contains 'Id') { [int]$process.Id } else { [int]$process.ProcessId }
        if ($null -eq $ProcessProvider -and ($null -eq $parentPid -or $parentPid -lt 1 -or [string]::IsNullOrWhiteSpace($commandLine))) {
            throw 'Process identity fields unavailable.'
        }
        return [PSCustomObject]@{
            Status = 'Available'
            PID = $returnedPid
            CreationTimeUtc = ConvertTo-RelayUtcRoundTrip -Value $creation
            ExecutablePath = Get-RelayNormalizedPath -Path $executablePath
            ParentPID = $parentPid
            CommandLine = $commandLine
        }
    }
    catch {
        return [PSCustomObject]@{
            Status = 'Unavailable'
            PID = $ProcessId
            CreationTimeUtc = $null
            ExecutablePath = $null
            ParentPID = $null
            CommandLine = $null
        }
    }
}

function Test-ManagedBackendIdentity {
    param(
        [Parameter(Mandatory)][psobject]$Config,
        $State,
        [scriptblock]$ListenerProvider,
        [scriptblock]$ProcessProvider,
        [scriptblock]$ProbeProvider
    )

    $result = [ordered]@{
        Managed = $false
        Status = 'Stale'
        Reason = 'Relay state is invalid.'
        ListenerPID = $null
        ProcessInfo = $null
        Probe = $null
    }
    if ($null -eq $State) {
        $result.Status = 'Absent'
        $result.Reason = 'Relay state is absent.'
        return [PSCustomObject]$result
    }

    try {
        $validatedState = ConvertTo-ValidatedRelayState -State $State
    }
    catch {
        return [PSCustomObject]$result
    }
    if ($validatedState.state -ne 'READY') {
        $result.Reason = 'Relay state is not ready.'
        return [PSCustomObject]$result
    }
    if ([int]$validatedState.backend.port -ne [int]$Config.Port) {
        $result.Status = 'Foreign'
        $result.Reason = 'Relay state port does not match the configured port.'
        return [PSCustomObject]$result
    }

    $listener = Get-RelayListener -Port $Config.Port -ListenerProvider $ListenerProvider
    if ($listener.Status -eq 'Conflict') {
        $result.Status = 'Conflict'
        $result.Reason = 'Multiple loopback listeners match the configured port.'
        return [PSCustomObject]$result
    }
    if ($listener.Status -eq 'Absent') {
        $result.Status = 'Absent'
        $result.Reason = 'No loopback listener matches the configured port.'
        return [PSCustomObject]$result
    }
    $result.ListenerPID = $listener.PID
    if ([int]$listener.PID -ne [int]$validatedState.backend.pid) {
        $result.Status = 'Foreign'
        $result.Reason = 'The loopback listener belongs to a different process.'
        return [PSCustomObject]$result
    }

    $processInfo = Get-RelayProcessInfo -ProcessId $validatedState.backend.pid -ProcessProvider $ProcessProvider
    $result.ProcessInfo = $processInfo
    if ($processInfo.Status -ne 'Available') {
        $result.Status = 'Stale'
        $result.Reason = 'The recorded backend process is unavailable.'
        return [PSCustomObject]$result
    }
    if ($processInfo.CreationTimeUtc -cne $validatedState.backend.createdUtc) {
        $result.Reason = 'The recorded backend creation time does not match.'
        return [PSCustomObject]$result
    }
    if ($processInfo.ExecutablePath -ine $validatedState.backend.executable) {
        $result.Status = 'Foreign'
        $result.Reason = 'The recorded backend executable does not match.'
        return [PSCustomObject]$result
    }
    if ($null -ne $validatedState.backend.parentPid -and $processInfo.ParentPID -ne [int]$validatedState.backend.parentPid) {
        $result.Reason = 'The recorded backend parent process does not match.'
        return [PSCustomObject]$result
    }

    $probe = if ($null -ne $ProbeProvider) { & $ProbeProvider $Config } else { Invoke-RelayBackendProbe -Config $Config }
    $result.Probe = $probe
    if ($null -eq $probe -or -not $probe.Ready) {
        $result.Status = 'Unhealthy'
        $result.Reason = 'The backend health probe did not report ready.'
        return [PSCustomObject]$result
    }
    if ([string]$probe.Version -cne [string]$validatedState.backend.version) {
        $result.Status = 'Unhealthy'
        $result.Reason = 'The backend version does not match the recorded state.'
        return [PSCustomObject]$result
    }

    $result.Managed = $true
    $result.Status = 'Managed'
    $result.Reason = 'Backend identity and authenticated health probe agree.'
    return [PSCustomObject]$result
}

function Use-RelayMutex {
    param(
        [Parameter(Mandatory)][psobject]$Config,
        [Parameter(Mandatory)][scriptblock]$ScriptBlock,
        [Parameter(Mandatory)][ValidateRange(0, [int]::MaxValue)][int]$TimeoutMs
    )

    $sid = try {
        [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    }
    catch {
        [Environment]::UserName
    }
    $safeSid = ($sid -replace '[^A-Za-z0-9_-]', '_')
    $name = "Local\OpenCodeRelayServer-$safeSid-$([int]$Config.Port)"
    $mutex = [Threading.Mutex]::new($false, $name)
    $acquired = $false
    try {
        try {
            $acquired = $mutex.WaitOne($TimeoutMs)
        }
        catch [Threading.AbandonedMutexException] {
            $acquired = $true
        }
        if (-not $acquired) {
            throw 'Relay mutex acquisition timed out.'
        }
        return & $ScriptBlock
    }
    finally {
        if ($acquired) {
            $mutex.ReleaseMutex()
        }
        $mutex.Dispose()
    }
}

function Get-RelayTunnelStatus {
    param(
        [Parameter(Mandatory)][psobject]$Config
    )

    $scriptPath = [string]$Config.TunnelScript
    if ([string]::IsNullOrWhiteSpace($scriptPath)) {
        return [PSCustomObject]@{ Status = 'NotConfigured'; Script = $null }
    }

    return [PSCustomObject]@{
        Status = if (Test-Path -LiteralPath $scriptPath -PathType Leaf) { 'Configured' } else { 'Missing' }
        Script = $scriptPath
    }
}

function Get-RelayStatus {
    param(
        [Parameter(Mandatory)][psobject]$Config,
        [scriptblock]$ListenerProvider,
        [scriptblock]$ProcessProvider,
        [scriptblock]$ProbeProvider
    )

    $state = Read-RelayState -Config $Config
    $tunnel = Get-RelayTunnelStatus -Config $Config
    $generation = if ($null -eq $state) { 0 } else { [int]$state.generation }
    $backendPid = if ($null -eq $state -or $null -eq $state.backend) { $null } else { [int]$state.backend.pid }
    $backendVersion = if ($null -eq $state -or $null -eq $state.backend) { $null } else { [string]$state.backend.version }
    $backendStatus = 'Absent'
    $ready = $false
    $relayState = 'Stopped'
    $warnings = [Collections.Generic.List[string]]::new()
    if ($null -ne $state -and -not [string]::IsNullOrWhiteSpace([string]$state.lastError)) {
        $warnings.Add([string]$state.lastError)
    }

    if ($null -eq $state) {
        $listener = Get-RelayListener -Port $Config.Port -ListenerProvider $ListenerProvider
        switch ($listener.Status) {
            'Unique' {
                $relayState = 'Foreign'
                $backendStatus = 'Foreign'
                $backendPid = $listener.PID
            }
            'Conflict' {
                $relayState = 'Conflict'
                $backendStatus = 'Conflict'
            }
        }
    }
    elseif ($null -eq $state.backend) {
        $relayState = if ($state.state -eq 'STOPPED') { 'Stopped' } else { [string]$state.state }
    }
    else {
        if ($state.state -eq 'DEGRADED') {
            $relayState = 'DEGRADED'
            $backendStatus = 'Unhealthy'
        }
        else {
            $identity = Test-ManagedBackendIdentity -Config $Config -State $state -ListenerProvider $ListenerProvider -ProcessProvider $ProcessProvider -ProbeProvider $ProbeProvider
            $backendStatus = $identity.Status
            if ($null -ne $identity.ListenerPID) {
                $backendPid = $identity.ListenerPID
            }
            if ($null -ne $identity.Probe -and -not [string]::IsNullOrWhiteSpace([string]$identity.Probe.Version)) {
                $backendVersion = [string]$identity.Probe.Version
            }
            if ($identity.Managed) {
                $relayState = 'Ready'
                $backendStatus = 'Managed'
                $ready = $true
            }
            else {
                # Once a READY generation exists, an absent listener is stale state,
                # rather than the clean stopped state used when no state exists.
                $relayState = if ($identity.Status -eq 'Absent') { 'Stale' } else { [string]$identity.Status }
            }
        }
    }

    return [PSCustomObject]@{
        State = $relayState
        Generation = $generation
        Backend = [PSCustomObject]@{
            Status = $backendStatus
            PID = $backendPid
            Version = $backendVersion
            Port = [int]$Config.Port
            Ready = [bool]$ready
        }
        Tunnel = $tunnel
        Warnings = @($warnings)
    }
}

function Invoke-RelayAnonymousHealthProbe {
    param(
        [Parameter(Mandatory)][psobject]$Config
    )

    $client = [Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds(3)
    $response = $null
    try {
        $response = $client.GetAsync("http://$($Config.Host):$($Config.Port)/global/health").GetAwaiter().GetResult()
        $statusCode = [int]$response.StatusCode
        return [PSCustomObject]@{
            StatusCode = $statusCode
            Status = if ($statusCode -eq 401) { 'Protected' } elseif ($response.IsSuccessStatusCode) { 'Unprotected' } else { 'Unexpected' }
        }
    }
    catch {
        return [PSCustomObject]@{ StatusCode = $null; Status = 'Unavailable' }
    }
    finally {
        if ($null -ne $response) { $response.Dispose() }
        $client.Dispose()
    }
}

function Get-RelayEnvironmentState {
    param(
        [hashtable]$Environment,
        [Parameter(Mandatory)][string]$Name
    )

    if ($null -ne $Environment -and $Environment.ContainsKey($Name) -and -not [string]::IsNullOrWhiteSpace([string]$Environment[$Name])) {
        return 'SET'
    }
    return 'UNSET'
}

function Get-RelayDoctorReport {
    param(
        [Parameter(Mandatory)][psobject]$Config,
        [hashtable]$ProcessEnvironment,
        [hashtable]$UserEnvironment,
        [scriptblock]$AnonymousProbeProvider,
        [scriptblock]$TunnelStatusProvider
    )

    if ($null -eq $ProcessEnvironment) {
        $ProcessEnvironment = @{}
        foreach ($name in @('OPENCODE_SERVER_USERNAME', 'OPENCODE_SERVER_PASSWORD')) {
            if ($null -ne [Environment]::GetEnvironmentVariable($name, 'Process')) {
                $ProcessEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            }
        }
    }
    if ($null -eq $UserEnvironment) {
        $UserEnvironment = ConvertTo-DefinedRelayEnvironment -ValueReader {
            param($name)
            Get-UserEnvironmentValue -Name $name
        }
    }

    $status = Get-RelayStatus -Config $Config
    $anonymous = if ($null -ne $AnonymousProbeProvider) { & $AnonymousProbeProvider $Config } else { Invoke-RelayAnonymousHealthProbe -Config $Config }
    $authenticatedProbe = Invoke-RelayBackendProbe -Config $Config
    $tunnel = if ($null -ne $TunnelStatusProvider) { & $TunnelStatusProvider $Config.TunnelScript } else { Get-RelayTunnelStatus -Config $Config }

    return [PSCustomObject]@{
        Port = [int]$Config.Port
        State = $status.State
        Listener = $status.Backend.Status
        Identity = $status.Backend.Status
        Credentials = [PSCustomObject]@{
            Process = [PSCustomObject]@{
                Username = Get-RelayEnvironmentState -Environment $ProcessEnvironment -Name 'OPENCODE_SERVER_USERNAME'
                Password = Get-RelayEnvironmentState -Environment $ProcessEnvironment -Name 'OPENCODE_SERVER_PASSWORD'
            }
            User = [PSCustomObject]@{
                Username = Get-RelayEnvironmentState -Environment $UserEnvironment -Name 'OPENCODE_SERVER_USERNAME'
                Password = Get-RelayEnvironmentState -Environment $UserEnvironment -Name 'OPENCODE_SERVER_PASSWORD'
            }
        }
        AnonymousHealth = [PSCustomObject]@{
            Status = [string]$anonymous.Status
            StatusCode = $anonymous.StatusCode
        }
        Authenticated = [PSCustomObject]@{
            Status = if ($authenticatedProbe.Ready) { 'Ready' } else { 'Unhealthy' }
            Version = $authenticatedProbe.Version
        }
        Tunnel = [PSCustomObject]@{
            Status = [string]$tunnel.Status
            Script = $tunnel.Script
        }
    }
}

function Resolve-RelayCmdShimExecutable {
    param([Parameter(Mandatory)][string]$ShimPath)
    $normalizedShim = Get-RelayNormalizedPath -Path $ShimPath
    $shimDirectory = Split-Path -Parent $normalizedShim
    foreach ($line in @([IO.File]::ReadAllLines($normalizedShim, [Text.Encoding]::Default))) {
        if ($line -notmatch '"(?<target>[^"\r\n]+\.exe)"') { continue }
        $candidate = $Matches.target -replace '(?i)%dp0%', [regex]::Escape($shimDirectory)
        # The replacement above escapes literal backslashes only for regex parsing;
        # normalize it back into a native path before accepting the shim target.
        $candidate = $candidate -replace '\\\\', '\\'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return Get-RelayNormalizedPath -Path $candidate }
    }
    return $null
}

function Start-RelayBackendProduction {
    param(
        [Parameter(Mandatory)][psobject]$Config
    )

    $realOpenCode = Get-RelayNormalizedPath -Path ([string]$Config.RealOpenCode)
    if (-not (Test-Path -LiteralPath $realOpenCode -PathType Leaf)) {
        throw 'Configured OpenCode executable was not found.'
    }

    $logDirectory = Join-Path ([string]$Config.StateRoot) 'backend-logs'
    [IO.Directory]::CreateDirectory($logDirectory) | Out-Null
    $launchId = [guid]::NewGuid().ToString('N')
    $stdoutPath = Join-Path $logDirectory ("backend-$launchId.stdout.log")
    $stderrPath = Join-Path $logDirectory ("backend-$launchId.stderr.log")
    $launchFile = $realOpenCode
    $expectedExecutable = $realOpenCode
    if ([IO.Path]::GetExtension($realOpenCode) -ieq '.cmd') {
        $expectedExecutable = Resolve-RelayCmdShimExecutable -ShimPath $realOpenCode
        if ($null -ne $expectedExecutable) {
            # A resolved npm shim target is the real listener executable. Launch it
            # directly so no long-lived cmd/conhost wrapper can retain controller handles.
            $launchFile = $expectedExecutable
        }
        else {
            $shimNode = Join-Path (Split-Path -Parent $realOpenCode) 'node.exe'
            $expectedExecutable = if (Test-Path -LiteralPath $shimNode -PathType Leaf) { Get-RelayNormalizedPath -Path $shimNode } else { Get-RelayNormalizedPath -Path ((Get-Command node -ErrorAction Stop).Source) }
            $launchFile = $realOpenCode
        }
    }
    $attemptStartedUtc = [datetime]::UtcNow.ToString('o')
    $daemonLauncher = Join-Path $PSScriptRoot 'opencode-daemon-launcher.mjs'
    if (-not (Test-Path -LiteralPath $daemonLauncher -PathType Leaf)) { throw 'OpenCode daemon launcher was not found.' }
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = (Get-Command node -ErrorAction Stop).Source
    $startInfo.ArgumentList.Add($daemonLauncher)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.Environment['OPENCODE_SERVER_USERNAME'] = [string]$Config.Username
    $startInfo.Environment['OPENCODE_SERVER_PASSWORD'] = [string]$Config.Password
    $launcher = [Diagnostics.Process]::Start($startInfo)
    $envelope = @{ executable=$launchFile; args=@('serve','--hostname','127.0.0.1','--port',[string][int]$Config.Port); stdoutPath=$stdoutPath; stderrPath=$stderrPath } | ConvertTo-Json -Compress
    $launcher.StandardInput.Write($envelope); $launcher.StandardInput.Close()
    $handshakeLine = $launcher.StandardOutput.ReadLine()
    if (-not $launcher.WaitForExit(5000)) { try { $launcher.Kill($true) } catch {}; throw 'OpenCode daemon launcher did not exit within five seconds.' }
    $handshake = try { $handshakeLine | ConvertFrom-Json -ErrorAction Stop } catch { throw "OpenCode daemon launcher returned an invalid handshake: $($launcher.StandardError.ReadToEnd())" }
    if ($null -eq $handshake.pid -or [int]$handshake.pid -le 0) { throw 'OpenCode daemon launcher returned no child PID.' }
    return [PSCustomObject]@{
        Launcher = $launcher
        StartedUtc = $attemptStartedUtc
        OwnedPids = @($launcher.Id, [int]$handshake.pid)
        ExpectedExecutable = $expectedExecutable
        ExpectedCommand = [PSCustomObject]@{ Verb = 'serve'; Host = '127.0.0.1'; Port = [int]$Config.Port }
        StdoutPath = $stdoutPath
        StderrPath = $stderrPath
    }
}

function Test-RelayHandleStartTimeMatches {
    param([Parameter(Mandatory)]$HandleStartTime,[Parameter(Mandatory)][string]$ExpectedUtc)
    try {
        # WMI and Process.StartTime are sourced from the same Windows creation time
        # but can differ by a handful of sub-millisecond ticks. Keep the binding
        # tighter than scheduler resolution while avoiding a false conflict.
        $expectedTicks = [datetime]::Parse($ExpectedUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime().Ticks
        return [Math]::Abs($HandleStartTime.ToUniversalTime().Ticks - $expectedTicks) -le [TimeSpan]::TicksPerMillisecond
    }
    catch { return $false }
}

function Get-RelayVerifiedProcessHandle {
    param(
        [Parameter(Mandatory)][int]$Pid,
        [Parameter(Mandatory)][string]$CreatedUtc,
        [Parameter(Mandatory)][string]$Executable,
        [Nullable[int]]$ParentPid
    )

    # The Win32 snapshot supplies executable and parent fields. The Process handle
    # supplies the kill capability and its StartTime binds that snapshot to the very
    # same process instance before any destructive action is possible.
    $info = Get-RelayProcessInfo -ProcessId $Pid
    if ($info.Status -ne 'Available') { return [PSCustomObject]@{ Status='Gone'; Handle=$null } }
    if ($info.CreationTimeUtc -cne $CreatedUtc -or $info.ExecutablePath -ine $Executable -or ($null -ne $ParentPid -and $info.ParentPID -ne [int]$ParentPid)) {
        return [PSCustomObject]@{ Status='Conflict'; Handle=$null }
    }
    $handle = $null
    try {
        $handle = [Diagnostics.Process]::GetProcessById($Pid)
        if ($handle.HasExited) { $handle.Dispose(); return [PSCustomObject]@{ Status='Gone'; Handle=$null } }
        if ($handle.Id -ne $Pid -or -not (Test-RelayHandleStartTimeMatches -HandleStartTime $handle.StartTime -ExpectedUtc $CreatedUtc) -or -not (Test-RelayHandleStartTimeMatches -HandleStartTime $handle.StartTime -ExpectedUtc $info.CreationTimeUtc)) {
            $handle.Dispose()
            return [PSCustomObject]@{ Status='Conflict'; Handle=$null }
        }
        return [PSCustomObject]@{ Status='Owned'; Handle=$handle }
    }
    catch {
        if ($null -ne $handle) { $handle.Dispose() }
        return [PSCustomObject]@{ Status='Gone'; Handle=$null }
    }
}

function Add-RelayAttemptCapturedProcess {
    param([Parameter(Mandatory)]$Attempt, [Parameter(Mandatory)]$Info)
    if ($Info.Status -ne 'Available' -or @($Attempt.CapturedProcesses | Where-Object { $_.PID -eq $Info.PID }).Count -gt 0) { return }
    $handle = $null
    try {
        $handle = [Diagnostics.Process]::GetProcessById([int]$Info.PID)
        if ($handle.HasExited -or -not (Test-RelayHandleStartTimeMatches -HandleStartTime $handle.StartTime -ExpectedUtc $Info.CreationTimeUtc)) { $handle.Dispose(); return }
        $Attempt.CapturedProcesses += [PSCustomObject]@{
            PID = [int]$Info.PID; CreatedUtc = $Info.CreationTimeUtc; Executable = $Info.ExecutablePath
            ParentPID = $Info.ParentPID; CommandLine = $Info.CommandLine; Handle = $handle
        }
        $Attempt.OwnedPids = @($Attempt.OwnedPids + [int]$Info.PID | Select-Object -Unique)
        $handle = $null
    }
    catch { }
    finally { if ($null -ne $handle) { $handle.Dispose() } }
}

function Capture-RelayAttemptDescendants {
    param([Parameter(Mandatory)]$Attempt, [scriptblock]$ProcessProvider)
    if ($null -ne $ProcessProvider) { return }
    try {
        $records = @{}
        foreach ($row in @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)) {
            # One coherent process-table snapshot is intentionally used here. A
            # per-PID WMI round trip can miss a launcher that exits milliseconds
            # after spawning its owned child.
            try {
                if ([int]$row.ProcessId -lt 1 -or [int]$row.ParentProcessId -lt 1 -or [string]::IsNullOrWhiteSpace([string]$row.ExecutablePath) -or [string]::IsNullOrWhiteSpace([string]$row.CommandLine)) { continue }
                $info = [PSCustomObject]@{
                    Status='Available'; PID=[int]$row.ProcessId; CreationTimeUtc=(ConvertTo-RelayUtcRoundTrip -Value $row.CreationDate)
                    ExecutablePath=(Get-RelayNormalizedPath -Path ([string]$row.ExecutablePath)); ParentPID=[int]$row.ParentProcessId; CommandLine=[string]$row.CommandLine
                }
                $records[[int]$info.PID] = $info
            }
            catch { }
        }
        foreach ($candidate in @($records.GetEnumerator() | ForEach-Object { $_.Value })) {
            if ([datetime]::Parse($candidate.CreationTimeUtc).ToUniversalTime() -lt [datetime]::Parse($Attempt.StartedUtc).ToUniversalTime()) { continue }
            $current = $candidate; $seen = [Collections.Generic.List[object]]::new(); $visited = [Collections.Generic.HashSet[int]]::new(); $owned = $false
            while ($null -ne $current -and $visited.Add([int]$current.PID)) {
                $seen.Add($current)
                if ([int]$current.PID -in @($Attempt.OwnedPids)) { $owned = $true; break }
                if ($null -eq $current.ParentPID -or -not $records.ContainsKey([int]$current.ParentPID)) { break }
                $current = $records[[int]$current.ParentPID]
            }
            if ($owned) { foreach ($ownedInfo in $seen) { Add-RelayAttemptCapturedProcess -Attempt $Attempt -Info $ownedInfo } }
        }
    }
    catch {
        # A partial capture is still safe: only handles captured with immutable
        # identity may be cleaned up.
    }
}

function Dispose-RelayAttemptCapturedProcesses {
    param($Attempt)
    if ($null -eq $Attempt) { return }
    foreach ($captured in @($Attempt.CapturedProcesses)) { if ($null -ne $captured.Handle) { try { $captured.Handle.Dispose() } catch { } } }
    $Attempt.CapturedProcesses = @()
}

function Stop-RelayAttemptProcessTree {
    param([Parameter(Mandatory)]$Attempt, [Parameter(Mandatory)]$Deadline)
    try {
        # Never reacquire by PID during cleanup. Captured handles were validated
        # during polling while their parent chain still existed.
        $cleanupDeadline = New-RelayLifecycleDeadline -TimeoutMs 2000
        $capturedProcesses = @($Attempt.CapturedProcesses | Sort-Object { $_.ParentPID } -Descending)
        foreach ($captured in $capturedProcesses) {
            $handle = $captured.Handle
            if ($null -eq $handle) { continue }
            try {
                if ($handle.HasExited) { continue }
                $handle.Kill($true)
            }
            catch { }
        }
        foreach ($captured in $capturedProcesses) {
            $handle = $captured.Handle
            if ($null -eq $handle) { continue }
            try {
                if (-not $handle.HasExited) { $null = $handle.WaitForExit((Assert-RelayLifecycleRemaining -Deadline $cleanupDeadline)) }
            }
            catch { }
        }
    }
    finally { Dispose-RelayAttemptCapturedProcesses -Attempt $Attempt }
}

function ConvertTo-RelayLaunchAttempt {
    param($LaunchResult, [scriptblock]$ProcessProvider)

    if ($null -eq $LaunchResult) { return $null }
    $launcher = if ($LaunchResult.PSObject.Properties.Name -contains 'Launcher') { $LaunchResult.Launcher } else { $LaunchResult }
    $launcherPid = if ($null -ne $launcher -and $launcher.PSObject.Properties.Name -contains 'Id') { [int]$launcher.Id } else { 0 }
    $launcherInfo = if ($launcherPid -gt 0) { Get-RelayProcessInfo -ProcessId $launcherPid -ProcessProvider $ProcessProvider } else { $null }
    $startedUtc = if ($LaunchResult.PSObject.Properties.Name -contains 'StartedUtc' -and -not [string]::IsNullOrWhiteSpace([string]$LaunchResult.StartedUtc)) {
        ConvertTo-RelayUtcRoundTrip $LaunchResult.StartedUtc
    }
    elseif ($null -ne $launcherInfo -and $launcherInfo.Status -eq 'Available') {
        $launcherInfo.CreationTimeUtc
    }
    elseif ($null -ne $launcher -and $launcher.PSObject.Properties.Name -contains 'StartTime') {
        # Legacy injected launchers do not expose a pre-launch timestamp. Leave a
        # small clock-resolution margin; production always supplies one above.
        ConvertTo-RelayUtcRoundTrip $launcher.StartTime.ToUniversalTime().AddSeconds(-1)
    }
    else {
        [datetime]::UtcNow.ToString('o')
    }
    $ownedPids = if ($LaunchResult.PSObject.Properties.Name -contains 'OwnedPids') { @($LaunchResult.OwnedPids | ForEach-Object { [int]$_ } | Where-Object { $_ -gt 0 }) } else { @() }
    if ($launcherPid -gt 0 -and $launcherPid -notin $ownedPids) { $ownedPids += $launcherPid }
    $attempt = [PSCustomObject]@{
        Launcher = $launcher
        LauncherPid = $launcherPid
        LauncherCreatedUtc = if ($null -ne $launcherInfo -and $launcherInfo.Status -eq 'Available') { $launcherInfo.CreationTimeUtc } else { $null }
        StartedUtc = $startedUtc
        OwnedPids = @($ownedPids | Select-Object -Unique)
        ExpectedExecutable = if ($LaunchResult.PSObject.Properties.Name -contains 'ExpectedExecutable') { [string]$LaunchResult.ExpectedExecutable } else { $null }
        ExpectedCommand = if ($LaunchResult.PSObject.Properties.Name -contains 'ExpectedCommand') { $LaunchResult.ExpectedCommand } else { $null }
        ExpectedCommandPattern = if ($LaunchResult.PSObject.Properties.Name -contains 'ExpectedCommandPattern') { [string]$LaunchResult.ExpectedCommandPattern } else { $null }
        CapturedProcesses = @()
    }
    if ($launcher -is [Diagnostics.Process]) {
        # A test provider may deliberately hide process snapshots. The launched
        # Process object itself is still an immutable root handle we can retain.
        $capturedLauncherInfo = if ($null -ne $launcherInfo -and $launcherInfo.Status -eq 'Available') { $launcherInfo } else { Get-RelayProcessInfo -ProcessId $launcherPid }
        if ($capturedLauncherInfo.Status -eq 'Available') { Add-RelayAttemptCapturedProcess -Attempt $attempt -Info $capturedLauncherInfo }
    }
    foreach ($ownedPid in @($attempt.OwnedPids | Where-Object { $_ -ne $launcherPid })) {
        # Production provides only its launcher. A test/provider may additionally
        # return a process it observed directly; retain a real handle only after its
        # immutable identity snapshot is available from the OS.
        $ownedInfo = Get-RelayProcessInfo -ProcessId ([int]$ownedPid) -ProcessProvider $ProcessProvider
        if ($ownedInfo.Status -eq 'Available' -and $null -eq $ProcessProvider) { Add-RelayAttemptCapturedProcess -Attempt $attempt -Info $ownedInfo }
    }
    return $attempt
}

function Test-RelayExpectedServeCommand {
    param([Parameter(Mandatory)]$Attempt, [string]$CommandLine)

    if ($null -eq $Attempt.ExpectedCommand -and [string]::IsNullOrWhiteSpace([string]$Attempt.ExpectedCommandPattern)) { return $true }
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    if ($null -ne $Attempt.ExpectedCommand) {
        $expected = $Attempt.ExpectedCommand
        if ([string]$expected.Verb -ne 'serve' -or [int]$expected.Port -lt 1 -or [int]$expected.Port -gt 65535) { return $false }
        $serveMatch = $CommandLine -match '(?i)(?<!\S)serve(?!\S)'
        $portMatch = $CommandLine -match ('(?i)(?<!\S)--port\s+["'']?{0}["'']?(?!\S)' -f [regex]::Escape([string][int]$expected.Port))
        $hostMatch = [string]::IsNullOrWhiteSpace([string]$expected.Host) -or $CommandLine -match ('(?i)(?<!\S)--hostname\s+["'']?{0}["'']?(?!\S)' -f [regex]::Escape([string]$expected.Host))
        return $serveMatch -and $portMatch -and $hostMatch
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$Attempt.ExpectedCommandPattern)) {
        return $CommandLine -match [string]$Attempt.ExpectedCommandPattern
    }
    return $true
}

function Test-RelayLaunchAttemptCandidate {
    param([Parameter(Mandatory)]$Attempt, [Parameter(Mandatory)][int]$Pid, [scriptblock]$ProcessProvider)
    try {
        $process = Get-RelayProcessInfo -ProcessId $Pid -ProcessProvider $ProcessProvider
        if ($process.Status -ne 'Available') { return $false }
        if ([datetime]::Parse($process.CreationTimeUtc).ToUniversalTime() -lt [datetime]::Parse($Attempt.StartedUtc).ToUniversalTime()) { return $false }
        if (-not [string]::IsNullOrWhiteSpace([string]$Attempt.ExpectedExecutable) -and $process.ExecutablePath -ine [string]$Attempt.ExpectedExecutable) { return $false }
        if (-not (Test-RelayExpectedServeCommand -Attempt $Attempt -CommandLine $process.CommandLine)) { return $false }
        $current = $process
        $seen = [Collections.Generic.HashSet[int]]::new()
        $owned = @($Attempt.OwnedPids | ForEach-Object { [int]$_ })
        while ($null -ne $current -and $current.Status -eq 'Available' -and $seen.Add([int]$current.PID)) {
            if ([int]$current.PID -in $owned) {
                if ([int]$current.PID -eq [int]$Attempt.LauncherPid -and -not [string]::IsNullOrWhiteSpace([string]$Attempt.LauncherCreatedUtc) -and $current.CreationTimeUtc -cne [string]$Attempt.LauncherCreatedUtc) { return $false }
                $Attempt.OwnedPids = @($Attempt.OwnedPids + @($seen | ForEach-Object { [int]$_ }) | Select-Object -Unique)
                return $true
            }
            if ($null -eq $current.ParentPID -or [int]$current.ParentPID -lt 1) { return $false }
            $current = Get-RelayProcessInfo -ProcessId ([int]$current.ParentPID) -ProcessProvider $ProcessProvider
        }
        return $false
    }
    catch { return $false }
}

function Start-RelayBackend {
    param(
        [Parameter(Mandatory)][psobject]$Config,
        [scriptblock]$StartBackendProvider,
        [scriptblock]$ListenerProvider,
        [scriptblock]$ProcessProvider,
        [scriptblock]$ProbeProvider,
        [ValidateRange(1, 60000)][int]$ReadyTimeoutMs = 20000,
        [ValidateRange(1, 10000)][int]$PollMs = 200,
        [switch]$AllowStaleRecovery
    )

    return Use-RelayMutex -Config $Config -TimeoutMs $ReadyTimeoutMs -ScriptBlock {
        $state = $null
        try {
            $state = Read-RelayState -Config $Config
        }
        catch {
            throw 'Relay stale state requires restart.'
        }
        $listener = Get-RelayListener -Port $Config.Port -ListenerProvider $ListenerProvider
        $nextGeneration = if ($null -eq $state) { 1 } else { [int]$state.generation + 1 }
        if ($listener.Status -eq 'Conflict') {
            throw 'Relay ownership conflict: listener ownership is ambiguous.'
        }

            if ($null -ne $state -and $state.state -in @('STOPPED','DEGRADED')) {
                if ($listener.Status -eq 'Unique') { throw 'Relay ownership conflict: a listener already occupies the configured port.' }
                $state = $null
            }
        if ($null -ne $state) {
            $identity = Test-ManagedBackendIdentity -Config $Config -State $state -ListenerProvider $ListenerProvider -ProcessProvider $ProcessProvider -ProbeProvider $ProbeProvider
            if ($identity.Managed) {
                return Get-RelayStatus -Config $Config -ListenerProvider $ListenerProvider -ProcessProvider $ProcessProvider -ProbeProvider $ProbeProvider
            }
            if ($AllowStaleRecovery -and $identity.Status -in @('Stale', 'Absent') -and $listener.Status -eq 'Absent') {
                $state = $null
            }
            elseif ($identity.Status -in @('Foreign', 'Conflict') -or $listener.Status -eq 'Unique') {
                throw 'Relay ownership conflict: recorded state does not own the listener.'
            }
            else {
                throw 'Relay stale backend requires restart.'
            }
        }
        if ($listener.Status -eq 'Unique') {
            throw 'Relay ownership conflict: a listener already occupies the configured port.'
        }

        $launcher = $null
        $attempt = $null
        try {
            if ($null -ne $StartBackendProvider) {
                $launcher = & $StartBackendProvider $Config
            }
            else {
                $launcher = Start-RelayBackendProduction -Config $Config
            }
            $attempt = ConvertTo-RelayLaunchAttempt -LaunchResult $launcher -ProcessProvider $ProcessProvider
            if ($null -eq $attempt -or @($attempt.OwnedPids).Count -eq 0) { throw 'Relay backend start failed.' }
            Capture-RelayAttemptDescendants -Attempt $attempt -ProcessProvider $ProcessProvider
        }
        catch {
            throw 'Relay backend start failed.'
        }

        try {
            $deadline = New-RelayLifecycleDeadline -TimeoutMs $ReadyTimeoutMs
            while ((Get-RelayLifecycleRemainingMs -Deadline $deadline) -gt 0) {
                Capture-RelayAttemptDescendants -Attempt $attempt -ProcessProvider $ProcessProvider
                $candidate = Get-RelayListener -Port $Config.Port -ListenerProvider $ListenerProvider
                if ($candidate.Status -eq 'Conflict') {
                    throw 'Relay ownership conflict: listener ownership became ambiguous during startup.'
                }
                if ($candidate.Status -eq 'Unique' -and (Test-RelayLaunchAttemptCandidate -Attempt $attempt -Pid $candidate.PID -ProcessProvider $ProcessProvider)) {
                    $processInfo = Get-RelayProcessInfo -ProcessId $candidate.PID -ProcessProvider $ProcessProvider
                    $probe = if ($null -ne $ProbeProvider) { & $ProbeProvider $Config } else { Invoke-RelayBackendProbe -Config $Config }
                    if ($processInfo.Status -eq 'Available' -and $null -ne $probe -and $probe.Ready -and -not [string]::IsNullOrWhiteSpace([string]$probe.Version)) {
                        Write-RelayState -Config $Config -State ([PSCustomObject]@{
                            schema = 1
                            state = 'READY'
                            generation = $nextGeneration
                            backend = [PSCustomObject]@{
                                pid = [int]$candidate.PID
                                createdUtc = $processInfo.CreationTimeUtc
                                executable = $processInfo.ExecutablePath
                                parentPid = $processInfo.ParentPID
                                port = [int]$Config.Port
                                version = [string]$probe.Version
                            }
                        })
                        Dispose-RelayAttemptCapturedProcesses -Attempt $attempt
                        return Get-RelayStatus -Config $Config -ListenerProvider $ListenerProvider -ProcessProvider $ProcessProvider -ProbeProvider $ProbeProvider
                    }
                }
                $remainingPollMs = Get-RelayLifecycleRemainingMs -Deadline $deadline
                if ($remainingPollMs -le 0) { break }
                Start-Sleep -Milliseconds ([Math]::Min($PollMs, $remainingPollMs))
            }
            throw 'Relay backend start failed: backend did not become healthy before timeout.'
        }
        catch {
            Stop-RelayAttemptProcessTree -Attempt $attempt -Deadline $deadline
            throw
        }
    }
}

function Write-RelayClientLeaseFileAtomic {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Lease)
    $directory = [IO.Path]::GetDirectoryName($Path)
    $tmp = Join-Path $directory ('.{0}.{1}.{2}.tmp' -f [IO.Path]::GetFileName($Path), $PID, [guid]::NewGuid().ToString('N'))
    $stream = $null
    $writer = $null
    try {
        [IO.Directory]::CreateDirectory($directory) | Out-Null
        $stream = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
        $writer.Write(($Lease | ConvertTo-Json -Depth 3 -Compress))
        $writer.Flush()
        $stream.Flush($true)
        $writer.Dispose()
        $writer = $null
        $stream.Dispose()
        $stream = $null
        if (Test-Path -LiteralPath $Path) { [IO.File]::Move($tmp, $Path, $true) } else { [IO.File]::Move($tmp, $Path) }
    }
    finally {
        if ($null -ne $writer) { $writer.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}

function Get-RelayLeasePath {
    param([psobject]$Config, [int]$Pid, $CreationUtc)
    $created = if ($CreationUtc -is [datetime]) { $CreationUtc.ToUniversalTime() } else { [datetime]::Parse([string]$CreationUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() }
    return Join-Path (Join-Path $Config.StateRoot 'clients') ("$Pid-$($created.Ticks).json")
}

function Register-RelayClientLease {
    param(
        [Parameter(Mandatory)][psobject]$Config, [Parameter(Mandatory)][int]$Pid,
        [Parameter(Mandatory)][string]$Directory, [string]$SessionID,
        [Parameter(Mandatory)][int]$BackendGeneration, [scriptblock]$ProcessProvider
    )
    if ([string]::IsNullOrWhiteSpace($Directory)) { throw 'Relay lease directory is required.' }
    return Use-RelayMutex -Config $Config -TimeoutMs 20000 -ScriptBlock {
        # State must be observed only after the lifecycle lock is held; a restart can
        # otherwise transition after this check and before the lease is made durable.
        $state = Read-RelayState -Config $Config
        if ($null -eq $state -or $state.state -ne 'READY' -or [int]$state.generation -ne $BackendGeneration) { throw 'Relay lease registration requires the current READY generation.' }
        $process = Get-RelayProcessInfo -ProcessId $Pid -ProcessProvider $ProcessProvider
        if ($process.Status -ne 'Available' -or $null -eq $process.ParentPID) { throw 'Relay lease registration requires a live process with a verified parent.' }
        $now = [datetime]::UtcNow.ToString('o')
        $lease = [PSCustomObject]@{ schema = 1; pid = $process.PID; parentPid = [int]$process.ParentPID; createdUtc = $process.CreationTimeUtc; executable = $process.ExecutablePath; backendGeneration = [int]$BackendGeneration; directory = $Directory; sessionID = $SessionID; lastHeartbeatUtc = $now }
        Write-RelayClientLeaseFileAtomic -Path (Get-RelayLeasePath -Config $Config -Pid $lease.pid -CreationUtc $lease.createdUtc) -Lease $lease
        return $lease
    }
}

function Test-RelayClientLease {
    param([psobject]$Config, $Lease, [string]$Path, [scriptblock]$ProcessProvider, $State)
    try {
        if ($null -eq $Lease -or [int]$Lease.schema -ne 1 -or [int]$Lease.pid -lt 1 -or [int]$Lease.parentPid -lt 1 -or [int]$Lease.backendGeneration -lt 1 -or [string]::IsNullOrWhiteSpace([string]$Lease.createdUtc) -or [string]::IsNullOrWhiteSpace([string]$Lease.executable) -or [string]::IsNullOrWhiteSpace([string]$Lease.directory)) { return $false }
        # State roots can be represented with an equivalent long/short Windows path;
        # the immutable filename still binds the PID to its creation timestamp.
        $expectedPath = Get-RelayLeasePath -Config $Config -Pid ([int]$Lease.pid) -CreationUtc ([string]$Lease.createdUtc)
        if ([IO.Path]::GetFileName($Path) -cne [IO.Path]::GetFileName($expectedPath)) { return $false }
        if ($null -eq $State -or [int]$Lease.backendGeneration -ne [int]$State.generation) { return $false }
        $process = Get-RelayProcessInfo -ProcessId ([int]$Lease.pid) -ProcessProvider $ProcessProvider
        $leaseTicks = if ($Lease.createdUtc -is [datetime]) { $Lease.createdUtc.ToUniversalTime().Ticks } else { [datetime]::Parse([string]$Lease.createdUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime().Ticks }
        $sameCreation = ([datetime]::Parse([string]$process.CreationTimeUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime().Ticks -eq $leaseTicks)
        $ok = $process.Status -eq 'Available' -and $sameCreation -and $process.ExecutablePath -ieq $Lease.executable -and $process.ParentPID -eq [int]$Lease.parentPid
        return $ok
    }
    catch { return $false }
}

function Read-RelayClientLeaseFile {
    param([Parameter(Mandatory)][string]$Path)
    $raw = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
    $lease = $raw | ConvertFrom-Json -ErrorAction Stop
    # ConvertFrom-Json converts ISO timestamps to local DateTime values on some
    # PowerShell versions. Preserve the JSON UTC string for identity comparison.
    $document = [Text.Json.JsonDocument]::Parse($raw)
    try { $lease.createdUtc = $document.RootElement.GetProperty('createdUtc').GetString() } finally { $document.Dispose() }
    return $lease
}

function Get-VerifiedRelayClientLeases {
    param([Parameter(Mandatory)][psobject]$Config, [scriptblock]$ProcessProvider)
    $state = Read-RelayState -Config $Config
    $root = Join-Path $Config.StateRoot 'clients'
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { return @() }
    $verified = [Collections.Generic.List[object]]::new()
    foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
        $lease = $null
        $valid = $false
        try {
            $lease = Read-RelayClientLeaseFile -Path $file.FullName
            $valid = Test-RelayClientLease -Config $Config -Lease $lease -Path $file.FullName -ProcessProvider $ProcessProvider -State $state
        }
        catch {
            # A damaged client record must not abort shutdown of other verified clients.
            $valid = $false
        }
        if ($valid) {
            $null = $verified.Add($lease)
        }
        else {
            try { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop } catch { }
        }
    }
    return $verified.ToArray()
}

function Update-RelayClientLeaseHeartbeat {
    param([Parameter(Mandatory)][psobject]$Config, [Parameter(Mandatory)][int]$Pid, [Parameter(Mandatory)][string]$CreationUtc, [scriptblock]$ProcessProvider)
    return Use-RelayMutex -Config $Config -TimeoutMs 20000 -ScriptBlock {
        $path = Get-RelayLeasePath -Config $Config -Pid $Pid -CreationUtc $CreationUtc
        if (-not (Test-Path -LiteralPath $path)) { throw 'Relay lease is not registered.' }
        try { $lease = Read-RelayClientLeaseFile -Path $path } catch { throw 'Relay lease is invalid.' }
        # As with registration, re-read the lifecycle state only under the same
        # mutex used by restart/stop before publishing a new heartbeat.
        $state = Read-RelayState -Config $Config
        if ($null -eq $state -or $state.state -ne 'READY' -or [int]$lease.backendGeneration -ne [int]$state.generation -or -not (Test-RelayClientLease -Config $Config -Lease $lease -Path $path -ProcessProvider $ProcessProvider -State $state)) {
            Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            throw 'Relay lease is not verified.'
        }
        $lease.lastHeartbeatUtc = [datetime]::UtcNow.ToString('o')
        Write-RelayClientLeaseFileAtomic -Path $path -Lease $lease
        return $lease
    }
}

function Unregister-RelayClientLease {
    param([Parameter(Mandatory)][psobject]$Config, [Parameter(Mandatory)][int]$Pid, [Parameter(Mandatory)][string]$CreationUtc)
    $path = Get-RelayLeasePath -Config $Config -Pid $Pid -CreationUtc $CreationUtc
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction Stop; return $true }; return $false
}

function New-RelayLifecycleDeadline {
    param([Parameter(Mandatory)][ValidateRange(1, 60000)][int]$TimeoutMs, [scriptblock]$NowProvider)
    $now = if ($null -ne $NowProvider) { & $NowProvider } else { [datetime]::UtcNow }
    return [PSCustomObject]@{ UtcDeadline = $now.ToUniversalTime().AddMilliseconds($TimeoutMs); NowProvider = $NowProvider }
}

function Get-RelayLifecycleRemainingMs {
    param([Parameter(Mandatory)]$Deadline)
    $now = if ($null -ne $Deadline.NowProvider) { & $Deadline.NowProvider } else { [datetime]::UtcNow }
    return [Math]::Max(0, [int][Math]::Floor(($Deadline.UtcDeadline - $now.ToUniversalTime()).TotalMilliseconds))
}

function Assert-RelayLifecycleRemaining {
    param([Parameter(Mandatory)]$Deadline)
    $remaining = Get-RelayLifecycleRemainingMs -Deadline $Deadline
    if ($remaining -le 0) { throw 'Relay lifecycle deadline expired.' }
    return $remaining
}

function Invoke-RelayLifecycleSleep {
    param([Parameter(Mandatory)]$Deadline, [Parameter(Mandatory)][int]$RequestedMs, [scriptblock]$SleepProvider)
    $remaining = Assert-RelayLifecycleRemaining -Deadline $Deadline
    $sleepMs = [Math]::Min($remaining, [Math]::Max(1, $RequestedMs))
    if ($null -ne $SleepProvider) { & $SleepProvider $sleepMs $Deadline } else { Start-Sleep -Milliseconds $sleepMs }
}

function Test-RelayClientKillOwnership {
    param([Parameter(Mandatory)][psobject]$Config, [Parameter(Mandatory)]$SnapshotLease, [scriptblock]$ProcessProvider)
    try {
        $path = Get-RelayLeasePath -Config $Config -Pid ([int]$SnapshotLease.pid) -CreationUtc ([string]$SnapshotLease.createdUtc)
        # app.exit may have already allowed the client to leave cleanly. A vanished
        # lease or process is therefore a successful no-op, not an ownership claim.
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return 'Gone' }
        $state = Read-RelayState -Config $Config
        $currentLease = Read-RelayClientLeaseFile -Path $path
        foreach ($field in @('pid','parentPid','createdUtc','executable','backendGeneration','directory')) {
            if ([string]$currentLease.$field -cne [string]$SnapshotLease.$field) { return 'Conflict' }
        }
        if (Test-RelayClientLease -Config $Config -Lease $currentLease -Path $path -ProcessProvider $ProcessProvider -State $state) { return 'Owned' }
        $process = Get-RelayProcessInfo -ProcessId ([int]$SnapshotLease.pid) -ProcessProvider $ProcessProvider
        if ($process.Status -eq 'Unavailable') { return 'Gone' }
        return 'Conflict'
    }
    catch { return 'Conflict' }
}

function Get-RelayFailureBackendMetadata {
    param(
        [Parameter(Mandatory)][psobject]$Config,
        [Parameter(Mandatory)]$ExpectedBackend,
        [Parameter(Mandatory)][string]$TransitionState,
        [scriptblock]$ListenerProvider,
        [scriptblock]$ProcessProvider,
        [scriptblock]$ProbeProvider
    )

    try {
        $current = Read-RelayState -Config $Config
        if ($null -eq $current -or $current.state -ne $TransitionState -or $null -eq $current.backend) { return $null }
        foreach ($field in @('pid','createdUtc','executable','parentPid','port','version')) {
            if ([string]$current.backend.$field -cne [string]$ExpectedBackend.$field) { return $null }
        }
        $identityState = $current | Select-Object *
        $identityState.state = 'READY'
        $identity = Test-ManagedBackendIdentity -Config $Config -State $identityState -ListenerProvider $ListenerProvider -ProcessProvider $ProcessProvider -ProbeProvider $ProbeProvider
        if ($identity.Managed -or $identity.Status -eq 'Unhealthy') { return $current.backend }
    }
    catch { }
    return $null
}

function Get-RelaySafeLifecycleError {
    param([Parameter(Mandatory)][string]$Message)
    if ($Message -match 'deadline') { return 'Relay lifecycle deadline expired.' }
    if ($Message -match 'ownership') { return 'Relay ownership conflict.' }
    if ($Message -match 'replacement') { return 'Replacement backend failed to become healthy.' }
    if ($Message -match 'start failed') { return 'Relay backend start failed.' }
    return 'Relay backend restart failed.'
}

function Test-RelayBackendKillOwnership {
    param([Parameter(Mandatory)][psobject]$Config, [Parameter(Mandatory)]$ExpectedBackend, [Parameter(Mandatory)][string]$TransitionState, [Nullable[int]]$ExpectedParentPid, [scriptblock]$ListenerProvider, [scriptblock]$ProcessProvider, [scriptblock]$ProbeProvider)
    try {
        $current = Read-RelayState -Config $Config
        if ($null -eq $current -or $current.state -ne $TransitionState -or $null -eq $current.backend) { return $false }
        foreach ($field in @('pid','createdUtc','executable','parentPid','port','version')) {
            if ([string]$current.backend.$field -cne [string]$ExpectedBackend.$field) { return $false }
        }
        $identityState = $current | Select-Object *
        $identityState.state = 'READY'
        $identity = Test-ManagedBackendIdentity -Config $Config -State $identityState -ListenerProvider $ListenerProvider -ProcessProvider $ProcessProvider -ProbeProvider $ProbeProvider
        # 'Unhealthy' is reached only after the listener PID, process creation time,
        # executable, parent, and port all matched the recorded state; solely the
        # authenticated probe (or version) disagreed. That happens legitimately
        # after a credential rotation, and the process identity is still proven,
        # so replacement/stop of our own recorded process stays authorized.
        $identityProven = $identity.Managed -or $identity.Status -eq 'Unhealthy'
        return $identityProven -and ($null -eq $ExpectedParentPid -or $identity.ProcessInfo.ParentPID -eq $ExpectedParentPid)
    }
    catch { return $false }
}

function Invoke-RelayClientShutdown {
    param([psobject]$Config, [scriptblock]$TuiExitProvider, [scriptblock]$ActiveSessionProvider, [scriptblock]$AbortSessionProvider, [scriptblock]$StopProcessTreeProvider, [scriptblock]$SleepProvider, [scriptblock]$ProcessProvider, [Collections.Generic.List[string]]$Warnings, [Parameter(Mandatory)]$Deadline)
    $leases = @(Get-VerifiedRelayClientLeases -Config $Config -ProcessProvider $ProcessProvider)
    foreach ($dir in @($leases.directory | Select-Object -Unique)) {
        try { Assert-RelayLifecycleRemaining -Deadline $Deadline | Out-Null; if ($null -ne $TuiExitProvider) { & $TuiExitProvider $Config $dir $Deadline } else { Invoke-RelayLifecycleRequest -Config $Config -Method 'POST' -Path ('/tui/publish?directory=' + [uri]::EscapeDataString($dir)) -Body ([ordered]@{ type='tui.command.execute'; properties=[ordered]@{ command='app.exit' } }) -Deadline $Deadline | Out-Null } } catch { $Warnings.Add('TUI exit request failed.') }
        try {
            Assert-RelayLifecycleRemaining -Deadline $Deadline | Out-Null
            $sessions = if ($null -ne $ActiveSessionProvider) { @(& $ActiveSessionProvider $Config $dir $Deadline) } else { @((Invoke-RelayLifecycleRequest -Config $Config -Method 'GET' -Path ('/session/status?directory=' + [uri]::EscapeDataString($dir)) -Deadline $Deadline).PSObject.Properties | ForEach-Object { [PSCustomObject]@{ Id=$_.Name; Status=if ($_.Value -is [string]) { [string]$_.Value } elseif ($null -ne $_.Value -and $_.Value.PSObject.Properties.Name -contains 'type') { [string]$_.Value.type } else { $null } } }) }
            foreach ($session in $sessions | Where-Object { [string]$_.Status -in @('busy','retry') }) { try { Assert-RelayLifecycleRemaining -Deadline $Deadline | Out-Null; if ($null -ne $AbortSessionProvider) { & $AbortSessionProvider $Config ([string]$session.Id) $dir $Deadline } else { Invoke-RelayLifecycleRequest -Config $Config -Method 'POST' -Path ('/session/' + [uri]::EscapeDataString([string]$session.Id) + '/abort?directory=' + [uri]::EscapeDataString($dir)) -Deadline $Deadline | Out-Null } } catch { $Warnings.Add('Session abort request failed.') } }
        } catch { $Warnings.Add('Active session lookup failed.') }
    }
    Invoke-RelayLifecycleSleep -Deadline $Deadline -RequestedMs 5000 -SleepProvider $SleepProvider
    foreach ($lease in $leases) {
        Assert-RelayLifecycleRemaining -Deadline $Deadline | Out-Null
        $ownership = Test-RelayClientKillOwnership -Config $Config -SnapshotLease $lease -ProcessProvider $ProcessProvider
        if ($ownership -eq 'Gone') { continue }
        if ($ownership -ne 'Owned') { throw 'Relay ownership conflict: client lease changed before stop.' }
        if ($null -ne $StopProcessTreeProvider) { & $StopProcessTreeProvider $lease.pid $lease $Deadline } else {
            $outcome = Stop-RelayClientProcessTreeProduction -Config $Config -SnapshotLease $lease -Deadline $Deadline
            if ($outcome -eq 'Conflict') { throw 'Relay ownership conflict: client lease changed before stop.' }
        }
    }
}

function Invoke-RelayLifecycleRequest {
    param([psobject]$Config,[string]$Method,[string]$Path,$Body,[Parameter(Mandatory)]$Deadline,[scriptblock]$RequestProvider)
    if ($null -ne $RequestProvider) { Assert-RelayLifecycleRemaining -Deadline $Deadline | Out-Null; return & $RequestProvider $Config $Method $Path $Body $Deadline }
    $client=[Net.Http.HttpClient]::new(); $request=$null; $response=$null
    try { $client.Timeout=[TimeSpan]::FromMilliseconds((Assert-RelayLifecycleRemaining -Deadline $Deadline)); $request=[Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::$Method,"http://$($Config.Host):$($Config.Port)$Path"); $request.Headers.TryAddWithoutValidation('Authorization',(Get-BasicHeader -Config $Config))|Out-Null; if ($null -ne $Body) { $request.Content=[Net.Http.StringContent]::new(($Body|ConvertTo-Json -Depth 4 -Compress),[Text.Encoding]::UTF8,'application/json') }; $response=$client.Send($request); if(-not $response.IsSuccessStatusCode){throw 'Authenticated lifecycle request failed.'}; $text=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult(); if([string]::IsNullOrWhiteSpace($text)){return $null}; return $text|ConvertFrom-Json }
    finally { if($null -ne $response){$response.Dispose()};if($null -ne $request){$request.Dispose()};$client.Dispose() }
}

function Stop-RelayVerifiedProcessHandle {
    param([Parameter(Mandatory)][Diagnostics.Process]$Handle,[Parameter(Mandatory)]$Deadline)
    try {
        if ($Handle.HasExited) { return 'Gone' }
        $Handle.Kill($true)
        if (-not $Handle.WaitForExit((Assert-RelayLifecycleRemaining -Deadline $Deadline))) { throw 'Relay lifecycle deadline expired while waiting for the verified process.' }
        return 'Gone'
    }
    finally { $Handle.Dispose() }
}

function Stop-RelayClientProcessTreeProduction {
    param([Parameter(Mandatory)][psobject]$Config,[Parameter(Mandatory)]$SnapshotLease,[Parameter(Mandatory)]$Deadline)
    $verified = $null
    try {
        $path = Get-RelayLeasePath -Config $Config -Pid ([int]$SnapshotLease.pid) -CreationUtc ([string]$SnapshotLease.createdUtc)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return 'Gone' }
        $state = Read-RelayState -Config $Config
        $lease = Read-RelayClientLeaseFile -Path $path
        foreach ($field in @('pid','parentPid','createdUtc','executable','backendGeneration','directory')) {
            if ([string]$lease.$field -cne [string]$SnapshotLease.$field) { return 'Conflict' }
        }
        if (-not (Test-RelayClientLease -Config $Config -Lease $lease -Path $path -State $state)) { return 'Conflict' }
        $verified = Get-RelayVerifiedProcessHandle -Pid ([int]$lease.pid) -CreatedUtc ([string]$lease.createdUtc) -Executable ([string]$lease.executable) -ParentPid ([int]$lease.parentPid)
        if ($verified.Status -ne 'Owned') { return $verified.Status }
    }
    catch { return 'Conflict' }
    # Termination is deliberately outside the ownership classifier: a deadline or
    # OS termination error is a lifecycle failure, not an ownership conflict.
    return Stop-RelayVerifiedProcessHandle -Handle $verified.Handle -Deadline $Deadline
}

function Stop-RelayBackendProcessTreeProduction {
    param([Parameter(Mandatory)][psobject]$Config,[Parameter(Mandatory)]$ExpectedBackend,[Parameter(Mandatory)][string]$TransitionState,[Nullable[int]]$ExpectedParentPid,[scriptblock]$ListenerProvider,[scriptblock]$ProbeProvider,[Parameter(Mandatory)]$Deadline)
    if (-not (Test-RelayBackendKillOwnership -Config $Config -ExpectedBackend $ExpectedBackend -TransitionState $TransitionState -ExpectedParentPid $ExpectedParentPid -ListenerProvider $ListenerProvider -ProbeProvider $ProbeProvider)) { return 'Conflict' }
    $verified = Get-RelayVerifiedProcessHandle -Pid ([int]$ExpectedBackend.pid) -CreatedUtc ([string]$ExpectedBackend.createdUtc) -Executable ([string]$ExpectedBackend.executable) -ParentPid $ExpectedParentPid
    if ($verified.Status -ne 'Owned') { return $verified.Status }
    return Stop-RelayVerifiedProcessHandle -Handle $verified.Handle -Deadline $Deadline
}

function Wait-RelayPortFree {
    param([Parameter(Mandatory)][psobject]$Config,[Parameter(Mandatory)]$Deadline,[Parameter(Mandatory)][int]$PollMs,[scriptblock]$PortFreeProvider,[scriptblock]$ListenerProvider,[scriptblock]$SleepProvider)
    do {
        $free = if ($null -ne $PortFreeProvider) { & $PortFreeProvider $Config $Deadline } else { (Get-RelayListener -Port $Config.Port -ListenerProvider $ListenerProvider).Status -eq 'Absent' }
        if ($free) { return }
        Invoke-RelayLifecycleSleep -Deadline $Deadline -RequestedMs $PollMs -SleepProvider $SleepProvider
    } while ((Get-RelayLifecycleRemainingMs -Deadline $Deadline) -gt 0)
    throw 'Relay lifecycle deadline expired while waiting for the port to become free.'
}

function Stop-RelayBackend {
    param([Parameter(Mandatory)][psobject]$Config, [scriptblock]$TuiExitProvider, [scriptblock]$ActiveSessionProvider, [scriptblock]$AbortSessionProvider, [scriptblock]$StopProcessTreeProvider, [scriptblock]$SleepProvider, [scriptblock]$ListenerProvider, [scriptblock]$ProcessProvider, [scriptblock]$ProbeProvider, [scriptblock]$PortFreeProvider, [ValidateRange(1,60000)][int]$LifecycleTimeoutMs=20000, [ValidateRange(1,10000)][int]$PollMs=200, [scriptblock]$NowProvider)
    $deadline = New-RelayLifecycleDeadline -TimeoutMs $LifecycleTimeoutMs -NowProvider $NowProvider
    return Use-RelayMutex -Config $Config -TimeoutMs (Assert-RelayLifecycleRemaining -Deadline $deadline) -ScriptBlock {
        $state = Read-RelayState -Config $Config
        if ($null -ne $state -and $state.state -eq 'STOPPED' -and $null -eq $state.backend) { return [PSCustomObject]@{ State='Stopped'; Generation=$state.generation; Warnings=@() } }
        $identity = Test-ManagedBackendIdentity -Config $Config -State $state -ListenerProvider $ListenerProvider -ProcessProvider $ProcessProvider -ProbeProvider $ProbeProvider
        # Unhealthy = full process identity proven, probe-only failure (for example a
        # credential rotation). Stopping our own recorded process remains authorized.
        if (-not $identity.Managed -and $identity.Status -ne 'Unhealthy') { throw "Relay ownership conflict: backend is $($identity.Status)." }
        Write-RelayState -Config $Config -State ([PSCustomObject]@{ schema=1; state='STOPPING'; generation=$state.generation; backend=$state.backend })
        try {
            $warnings = [Collections.Generic.List[string]]::new(); Invoke-RelayClientShutdown -Config $Config -TuiExitProvider $TuiExitProvider -ActiveSessionProvider $ActiveSessionProvider -AbortSessionProvider $AbortSessionProvider -StopProcessTreeProvider $StopProcessTreeProvider -SleepProvider $SleepProvider -ProcessProvider $ProcessProvider -Warnings $warnings -Deadline $deadline
            Assert-RelayLifecycleRemaining -Deadline $deadline | Out-Null
            if (-not (Test-RelayBackendKillOwnership -Config $Config -ExpectedBackend $state.backend -TransitionState 'STOPPING' -ExpectedParentPid $identity.ProcessInfo.ParentPID -ListenerProvider $ListenerProvider -ProcessProvider $ProcessProvider -ProbeProvider $ProbeProvider)) { throw 'Relay ownership conflict: backend identity drifted before stop.' }
            if ($null -ne $StopProcessTreeProvider) { & $StopProcessTreeProvider $state.backend.pid $null $deadline } else {
                $outcome = Stop-RelayBackendProcessTreeProduction -Config $Config -ExpectedBackend $state.backend -TransitionState 'STOPPING' -ExpectedParentPid $identity.ProcessInfo.ParentPID -ListenerProvider $ListenerProvider -ProbeProvider $ProbeProvider -Deadline $deadline
                if ($outcome -eq 'Conflict') { throw 'Relay ownership conflict: backend identity drifted before stop.' }
            }
            Wait-RelayPortFree -Config $Config -Deadline $deadline -PollMs $PollMs -PortFreeProvider $PortFreeProvider -ListenerProvider $ListenerProvider -SleepProvider $SleepProvider
            Write-RelayState -Config $Config -State ([PSCustomObject]@{ schema=1; state='STOPPED'; generation=$state.generation; backend=$null })
            return [PSCustomObject]@{ State='Stopped'; Generation=$state.generation; Warnings=@($warnings) }
        }
        catch {
            $failureMessage = [string]$_.Exception.Message
            $failureBackend = Get-RelayFailureBackendMetadata -Config $Config -ExpectedBackend $state.backend -TransitionState 'STOPPING' -ListenerProvider $ListenerProvider -ProcessProvider $ProcessProvider -ProbeProvider $ProbeProvider
            Write-RelayState -Config $Config -State ([PSCustomObject]@{ schema=1; state='DEGRADED'; generation=$state.generation; backend=$failureBackend; lastError='Relay backend stop failed.' })
            if ($failureMessage -match 'ownership') { throw $_ }
            throw "Relay backend stop failed: $failureMessage"
        }
    }
}

function Restart-RelayBackend {
    param([Parameter(Mandatory)][psobject]$Config, [scriptblock]$TuiExitProvider, [scriptblock]$ActiveSessionProvider, [scriptblock]$AbortSessionProvider, [scriptblock]$StopProcessTreeProvider, [scriptblock]$StartBackendProvider, [scriptblock]$SleepProvider, [scriptblock]$ListenerProvider, [scriptblock]$ProcessProvider, [scriptblock]$ProbeProvider, [scriptblock]$PortFreeProvider, [ValidateRange(1,60000)][int]$ReadyTimeoutMs=20000, [ValidateRange(1,10000)][int]$PollMs=200, [ValidateRange(1,60000)][int]$LifecycleTimeoutMs=20000, [scriptblock]$NowProvider)
    $deadline = New-RelayLifecycleDeadline -TimeoutMs $LifecycleTimeoutMs -NowProvider $NowProvider
    $recoveryState = Read-RelayState -Config $Config
    $recoveryListener = Get-RelayListener -Port $Config.Port -ListenerProvider $ListenerProvider
    if ($recoveryListener.Status -eq 'Conflict') { throw 'Relay ownership conflict: listener ownership is ambiguous.' }
    if ($null -ne $recoveryState -and $recoveryListener.Status -eq 'Absent') {
        $recoveryIdentity = Test-ManagedBackendIdentity -Config $Config -State $recoveryState -ListenerProvider $ListenerProvider -ProcessProvider $ProcessProvider -ProbeProvider $ProbeProvider
        if ($recoveryState.state -in @('STOPPED', 'DEGRADED') -or $recoveryIdentity.Status -in @('Stale', 'Absent')) {
            $recoveryBudget = Assert-RelayLifecycleRemaining -Deadline $deadline
            return Start-RelayBackend -Config $Config -StartBackendProvider $StartBackendProvider -ListenerProvider $ListenerProvider -ProcessProvider $ProcessProvider -ProbeProvider $ProbeProvider -ReadyTimeoutMs ([Math]::Min($ReadyTimeoutMs, $recoveryBudget)) -PollMs $PollMs -AllowStaleRecovery
        }
    }
    return Use-RelayMutex -Config $Config -TimeoutMs (Assert-RelayLifecycleRemaining -Deadline $deadline) -ScriptBlock {
        $state = Read-RelayState -Config $Config; $identity = Test-ManagedBackendIdentity -Config $Config -State $state -ListenerProvider $ListenerProvider -ProcessProvider $ProcessProvider -ProbeProvider $ProbeProvider
        # Unhealthy = full process identity proven, probe-only failure (for example a
        # credential rotation). Replacing our own recorded process remains authorized.
        if (-not $identity.Managed -and $identity.Status -ne 'Unhealthy') { throw "Relay ownership conflict: backend is $($identity.Status)." }
        Write-RelayState -Config $Config -State ([PSCustomObject]@{ schema=1; state='RESTARTING'; generation=$state.generation; backend=$state.backend })
        try {
        $warnings = [Collections.Generic.List[string]]::new(); Invoke-RelayClientShutdown -Config $Config -TuiExitProvider $TuiExitProvider -ActiveSessionProvider $ActiveSessionProvider -AbortSessionProvider $AbortSessionProvider -StopProcessTreeProvider $StopProcessTreeProvider -SleepProvider $SleepProvider -ProcessProvider $ProcessProvider -Warnings $warnings -Deadline $deadline
        Assert-RelayLifecycleRemaining -Deadline $deadline | Out-Null
        if (-not (Test-RelayBackendKillOwnership -Config $Config -ExpectedBackend $state.backend -TransitionState 'RESTARTING' -ExpectedParentPid $identity.ProcessInfo.ParentPID -ListenerProvider $ListenerProvider -ProcessProvider $ProcessProvider -ProbeProvider $ProbeProvider)) { throw 'Relay ownership conflict: backend identity drifted before restart.' }
        try {
            if ($null -ne $StopProcessTreeProvider) { & $StopProcessTreeProvider $state.backend.pid $null $deadline } else {
                $outcome = Stop-RelayBackendProcessTreeProduction -Config $Config -ExpectedBackend $state.backend -TransitionState 'RESTARTING' -ExpectedParentPid $identity.ProcessInfo.ParentPID -ListenerProvider $ListenerProvider -ProbeProvider $ProbeProvider -Deadline $deadline
                if ($outcome -eq 'Conflict') { throw 'Relay ownership conflict: backend identity drifted before restart.' }
            }
        }
        catch {
            $failureMessage = [string]$_.Exception.Message
            $failureBackend = Get-RelayFailureBackendMetadata -Config $Config -ExpectedBackend $state.backend -TransitionState 'RESTARTING' -ListenerProvider $ListenerProvider -ProcessProvider $ProcessProvider -ProbeProvider $ProbeProvider
            Write-RelayState -Config $Config -State ([PSCustomObject]@{ schema=1; state='DEGRADED'; generation=$state.generation; backend=$failureBackend; lastError='Relay backend restart failed.' })
            if ($failureMessage -match 'ownership') { throw $_ }
            throw "Relay backend restart failed: $failureMessage"
        }
        Wait-RelayPortFree -Config $Config -Deadline $deadline -PollMs $PollMs -PortFreeProvider $PortFreeProvider -ListenerProvider $ListenerProvider -SleepProvider $SleepProvider
        $replacementAttempt = $null
        try {
            $replacementLauncher = if ($null -ne $StartBackendProvider) { & $StartBackendProvider $Config } else { Start-RelayBackendProduction -Config $Config }
            $replacementAttempt = ConvertTo-RelayLaunchAttempt -LaunchResult $replacementLauncher -ProcessProvider $ProcessProvider
            if ($null -eq $replacementAttempt -or @($replacementAttempt.OwnedPids).Count -eq 0) { throw 'Relay backend start failed: replacement did not create an owned launch attempt.' }
            Capture-RelayAttemptDescendants -Attempt $replacementAttempt -ProcessProvider $ProcessProvider
            do {
                Assert-RelayLifecycleRemaining -Deadline $deadline | Out-Null
                Capture-RelayAttemptDescendants -Attempt $replacementAttempt -ProcessProvider $ProcessProvider
                $listener = Get-RelayListener -Port $Config.Port -ListenerProvider $ListenerProvider
                if ($listener.Status -eq 'Unique' -and (Test-RelayLaunchAttemptCandidate -Attempt $replacementAttempt -Pid $listener.PID -ProcessProvider $ProcessProvider)) {
                    $process = Get-RelayProcessInfo -ProcessId $listener.PID -ProcessProvider $ProcessProvider; $probe = if ($null -ne $ProbeProvider) { & $ProbeProvider $Config } else { Invoke-RelayBackendProbe -Config $Config }
                    if ($process.Status -eq 'Available' -and $probe.Ready) {
                        Write-RelayState -Config $Config -State ([PSCustomObject]@{ schema=1; state='READY'; generation=($state.generation+1); backend=[PSCustomObject]@{ pid=$process.PID; createdUtc=$process.CreationTimeUtc; executable=$process.ExecutablePath; parentPid=$process.ParentPID; port=$Config.Port; version=$probe.Version } })
                        Dispose-RelayAttemptCapturedProcesses -Attempt $replacementAttempt
                        return [PSCustomObject]@{ State='Ready'; Generation=($state.generation+1); Warnings=@($warnings) }
                    }
                }
                Invoke-RelayLifecycleSleep -Deadline $deadline -RequestedMs $PollMs -SleepProvider $SleepProvider
            } while ((Get-RelayLifecycleRemainingMs -Deadline $deadline) -gt 0)
            throw 'Relay backend start failed: replacement did not become healthy.'
        } catch {
            if ($null -ne $replacementAttempt) { Stop-RelayAttemptProcessTree -Attempt $replacementAttempt -Deadline $deadline }
            Write-RelayState -Config $Config -State ([PSCustomObject]@{ schema=1; state='DEGRADED'; generation=$state.generation; backend=$null; lastError='Replacement backend failed to become healthy.' })
            throw $_
        }
        }
        catch {
            $current = Read-RelayState -Config $Config
            if ($null -eq $current -or $current.state -ne 'DEGRADED') {
                $failureBackend = Get-RelayFailureBackendMetadata -Config $Config -ExpectedBackend $state.backend -TransitionState 'RESTARTING' -ListenerProvider $ListenerProvider -ProcessProvider $ProcessProvider -ProbeProvider $ProbeProvider
                Write-RelayState -Config $Config -State ([PSCustomObject]@{ schema=1; state='DEGRADED'; generation=$state.generation; backend=$failureBackend; lastError=(Get-RelaySafeLifecycleError -Message ([string]$_.Exception.Message)) })
            }
            throw
        }
    }
}

function Invoke-RelayTunnelCommand {
    param([psobject]$Config,[Parameter(Mandatory)][ValidateSet('start','stop')][string]$Action,[Parameter(Mandatory)]$Deadline)
    if ([string]::IsNullOrWhiteSpace([string]$Config.TunnelScript) -or -not (Test-Path -LiteralPath $Config.TunnelScript -PathType Leaf)) { throw 'Configured relay tunnel script was not found.' }
    $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
    $process = Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile','-NoLogo','-File',$Config.TunnelScript,$Action) -PassThru -NoNewWindow
    $remaining = Assert-RelayLifecycleRemaining -Deadline $Deadline
    if (-not $process.WaitForExit($remaining)) {
        try { $process.Kill($true) } catch { }
        $null = $process.WaitForExit(1000)
        throw "Relay lifecycle deadline expired while waiting for tunnel $Action."
    }
    if ($process.ExitCode -ne 0) { throw "Relay tunnel $Action failed." }
    return [PSCustomObject]@{ Status=$Action; Script=$Config.TunnelScript }
}
function Restart-RelayTunnel {
    param([psobject]$Config,[scriptblock]$TunnelProvider,[ValidateRange(1,60000)][int]$LifecycleTimeoutMs=20000)
    if ($null -ne $TunnelProvider) { return & $TunnelProvider 'restart' $Config }
    $deadline = New-RelayLifecycleDeadline -TimeoutMs $LifecycleTimeoutMs
    Invoke-RelayTunnelCommand -Config $Config -Action 'stop' -Deadline $deadline | Out-Null
    Invoke-RelayTunnelCommand -Config $Config -Action 'start' -Deadline $deadline | Out-Null
    return [PSCustomObject]@{ Status='restart'; Script=$Config.TunnelScript }
}
function Stop-RelayTunnel {
    param([psobject]$Config,[scriptblock]$TunnelProvider,[ValidateRange(1,60000)][int]$LifecycleTimeoutMs=20000)
    if ($null -ne $TunnelProvider) { return & $TunnelProvider 'stop' $Config }
    $deadline = New-RelayLifecycleDeadline -TimeoutMs $LifecycleTimeoutMs
    return Invoke-RelayTunnelCommand -Config $Config -Action 'stop' -Deadline $deadline
}

function Ensure-RelayTunnel {
    param(
        [Parameter(Mandatory)][psobject]$Config,
        [scriptblock]$TunnelProvider
    )

    $status = Get-RelayTunnelStatus -Config $Config
    if ($status.Status -eq 'NotConfigured') {
        return $status
    }
    if ($status.Status -eq 'Missing') {
        throw 'Configured relay tunnel script was not found.'
    }
    if ($null -ne $TunnelProvider) {
        return & $TunnelProvider $status.Script
    }

    try {
        $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
        $null = & $pwsh -NoProfile -NoLogo -File $status.Script start
        if ($LASTEXITCODE -ne 0) {
            throw 'Tunnel provider returned failure.'
        }
    }
    catch {
        throw 'Relay tunnel ensure failed.'
    }
    return [PSCustomObject]@{ Status = 'Ensured'; Script = $status.Script }
}

Export-ModuleMember -Function Get-UserEnvironmentValue, Get-RelayConfig, Get-BasicHeader, Invoke-RelayBackendProbe, Use-RelayMutex, Read-RelayState, Write-RelayState, Get-RelayListener, Get-RelayProcessInfo, Test-ManagedBackendIdentity, Get-RelayStatus, Get-RelayDoctorReport, Start-RelayBackend, Ensure-RelayTunnel, Register-RelayClientLease, Test-RelayClientLease, Update-RelayClientLeaseHeartbeat, Unregister-RelayClientLease, Get-VerifiedRelayClientLeases, New-RelayLifecycleDeadline, Invoke-RelayLifecycleRequest, Restart-RelayBackend, Stop-RelayBackend, Restart-RelayTunnel, Stop-RelayTunnel
