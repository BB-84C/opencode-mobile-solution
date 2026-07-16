#Requires -Version 7.2
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$PassThroughArgs)

$ErrorActionPreference = 'Stop'

if ($PassThroughArgs.Count -eq 0 -or $PassThroughArgs[0] -ine '--local') {
    Write-Error '[FAIL] opencode-local.ps1 must be invoked with --local as its first argument.'
    exit 2
}

$realOpenCode = $env:OPENCODE_REAL_CMD
if (-not $realOpenCode) {
    $realOpenCode = Join-Path $env:USERPROFILE 'AppData\Roaming\npm\opencode.cmd'
}
if (-not (Test-Path -LiteralPath $realOpenCode)) {
    Write-Error "[FAIL] OpenCode launcher not found at '$realOpenCode'."
    exit 1
}

[string[]]$remaining = @($PassThroughArgs | Select-Object -Skip 1)

# The escape hatch performs zero probes, state reads, or credential injection, and
# the child must not inherit the shared-server credentials (spec section 6).
Remove-Item -Path Env:OPENCODE_SERVER_USERNAME -ErrorAction SilentlyContinue
Remove-Item -Path Env:OPENCODE_SERVER_PASSWORD -ErrorAction SilentlyContinue

& $realOpenCode @remaining
exit $LASTEXITCODE
