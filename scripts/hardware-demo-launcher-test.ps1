$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot 'start-hardware-demo.ps1'
$stopScript = Join-Path $PSScriptRoot 'stop-hardware-demo.ps1'

foreach ($scriptPath in @($startScript, $stopScript)) {
  if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Required demo script is missing: $scriptPath"
  }

  $tokens = $null
  $parseErrors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count -gt 0) {
    throw "PowerShell parse error in $scriptPath`: $($parseErrors[0].Message)"
  }
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

$runtimeRoot = Join-Path ([System.IO.Path]::GetTempPath()) "haptic-relay-demo-test-$PID-$port"
$reuseRuntimeRoot = "$runtimeRoot-reuse"
$serverPid = $null

try {
  & $startScript -Port $port -ServerOnly -RuntimeRoot $runtimeRoot

  $statePath = Join-Path $runtimeRoot 'state.json'
  if (-not (Test-Path -LiteralPath $statePath)) {
    throw 'Demo launcher did not create state.json.'
  }

  $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
  $serverPid = [int]$state.server.pid
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 3
  if ($health.ok -ne $true) {
    throw 'Demo relay health check did not return ok=true.'
  }

  & $startScript -Port $port -ServerOnly -RuntimeRoot $reuseRuntimeRoot
  $reuseStatePath = Join-Path $reuseRuntimeRoot 'state.json'
  $reuseState = Get-Content -Raw -LiteralPath $reuseStatePath | ConvertFrom-Json
  if ($reuseState.ownsRelay -ne $false -or $null -ne $reuseState.server) {
    throw 'A healthy existing relay must be reused without claiming process ownership.'
  }
  & $stopScript -RuntimeRoot $reuseRuntimeRoot
  $healthAfterReuseStop = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 3
  if ($healthAfterReuseStop.ok -ne $true) {
    throw 'Stopping a reused demo must leave the existing relay running.'
  }

  & $stopScript -RuntimeRoot $runtimeRoot

  if (Test-Path -LiteralPath $statePath) {
    throw 'Demo stop script did not remove state.json.'
  }
  if (Get-Process -Id $serverPid -ErrorAction SilentlyContinue) {
    throw "Demo relay process is still running: $serverPid"
  }

  Write-Host 'hardware demo launcher tests passed'
} finally {
  if (Test-Path -LiteralPath $stopScript) {
    try { & $stopScript -RuntimeRoot $reuseRuntimeRoot } catch { Write-Warning $_ }
    try { & $stopScript -RuntimeRoot $runtimeRoot } catch { Write-Warning $_ }
  }

  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $runtimeFullPath = [System.IO.Path]::GetFullPath($runtimeRoot)
  if ($runtimeFullPath.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $runtimeFullPath)) {
    Remove-Item -LiteralPath $runtimeFullPath -Recurse -Force
  }
  $reuseRuntimeFullPath = [System.IO.Path]::GetFullPath($reuseRuntimeRoot)
  if ($reuseRuntimeFullPath.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $reuseRuntimeFullPath)) {
    Remove-Item -LiteralPath $reuseRuntimeFullPath -Recurse -Force
  }
}
