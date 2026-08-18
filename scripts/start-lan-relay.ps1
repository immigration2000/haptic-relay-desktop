param(
  [ValidateRange(1, 65535)]
  [int]$Port = 4175,
  [Parameter(Mandatory = $true)]
  [string]$PublicRelayUrl,
  [string]$RuntimeRoot = (Join-Path ([System.IO.Path]::GetTempPath()) 'HapticRelayLan')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$serverScript = Join-Path $root 'dist-server\server\src\relay-server.js'
$statePath = Join-Path $RuntimeRoot 'state.json'

$publicUri = $null
if (-not [System.Uri]::TryCreate($PublicRelayUrl, [System.UriKind]::Absolute, [ref]$publicUri)) {
  throw 'PublicRelayUrl must be an absolute HTTP or HTTPS URL.'
}
if ($publicUri.Scheme -notin @('http', 'https')) {
  throw 'PublicRelayUrl must use HTTP or HTTPS.'
}
if ($publicUri.Port -ne $Port) {
  throw "PublicRelayUrl port $($publicUri.Port) does not match relay port $Port."
}
if (-not (Test-Path -LiteralPath $serverScript)) {
  throw "Relay build not found: $serverScript. Run npm.cmd run build:server first."
}

if (Test-Path -LiteralPath $statePath) {
  $previousState = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
  $activeProcess = Get-Process -Id ([int]$previousState.pid) -ErrorAction SilentlyContinue
  if ($activeProcess) {
    throw "LAN relay is already running. PID: $($activeProcess.Id)"
  }
}

New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
$logsPath = Join-Path $RuntimeRoot 'logs'
New-Item -ItemType Directory -Path $logsPath -Force | Out-Null
$stdoutPath = Join-Path $logsPath 'relay.stdout.log'
$stderrPath = Join-Path $logsPath 'relay.stderr.log'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source

$environmentNames = @('HAPTIC_RELAY_HOST', 'HAPTIC_RELAY_PORT', 'HAPTIC_PUBLIC_RELAY_URL', 'HAPTIC_CONTROL_TOKEN_SECRET')
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
  $previousEnvironment[$name] = [System.Environment]::GetEnvironmentVariable($name, 'Process')
}

$randomBytes = New-Object byte[] 32
$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $random.GetBytes($randomBytes)
} finally {
  $random.Dispose()
}
$tokenSecret = -join ($randomBytes | ForEach-Object { $_.ToString('x2') })

$server = $null
try {
  $env:HAPTIC_RELAY_HOST = '0.0.0.0'
  $env:HAPTIC_RELAY_PORT = [string]$Port
  $env:HAPTIC_PUBLIC_RELAY_URL = $publicUri.AbsoluteUri.TrimEnd('/')
  $env:HAPTIC_CONTROL_TOKEN_SECRET = $tokenSecret

  $server = Start-Process -FilePath $nodePath `
    -ArgumentList @($serverScript) `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru
} finally {
  foreach ($name in $environmentNames) {
    [System.Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
  }
}

try {
  $healthy = $false
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    if ($server.HasExited) {
      $details = if (Test-Path -LiteralPath $stderrPath) { Get-Content -Raw -LiteralPath $stderrPath } else { '' }
      throw "LAN relay exited during startup. $details"
    }
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 1
      if ($health.ok -eq $true) {
        $healthy = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 100
    }
  }
  if (-not $healthy) { throw 'LAN relay health check timed out.' }

  $server.Refresh()
  [ordered]@{
    pid = $server.Id
    startedAtUtc = $server.StartTime.ToUniversalTime().ToString('o')
    executablePath = [System.IO.Path]::GetFullPath($nodePath)
    publicRelayUrl = $publicUri.AbsoluteUri.TrimEnd('/')
    port = $Port
    stdoutPath = [System.IO.Path]::GetFullPath($stdoutPath)
    stderrPath = [System.IO.Path]::GetFullPath($stderrPath)
  } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8

  Write-Output 'LAN relay started'
  Write-Output "Server URL: $($publicUri.AbsoluteUri.TrimEnd('/'))"
  Write-Output "PID: $($server.Id)"
  Write-Output "State: $statePath"
} catch {
  if ($server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force
    Wait-Process -Id $server.Id -ErrorAction SilentlyContinue
  }
  throw
}
