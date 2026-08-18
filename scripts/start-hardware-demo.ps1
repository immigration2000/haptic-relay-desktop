[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 4175,
  [switch]$ServerOnly,
  [switch]$ReuseExistingRelay,
  [string]$RuntimeRoot = (Join-Path ([System.IO.Path]::GetTempPath()) 'HapticRelayHardwareDemo'),
  [string]$AppExecutable = "$env:LOCALAPPDATA\Programs\Haptic Relay\Haptic Relay.exe"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$preflightScript = Join-Path $PSScriptRoot 'hardware-demo-preflight.ps1'
$serverScript = Join-Path $root 'dist-server\server\src\relay-server.js'
$statePath = Join-Path $RuntimeRoot 'state.json'
$startedProcesses = @()

function Get-ProcessRecord([System.Diagnostics.Process]$Process, [string]$ExecutablePath, [string]$Kind) {
  $Process.Refresh()
  return [ordered]@{
    pid = $Process.Id
    startedAtUtc = $Process.StartTime.ToUniversalTime().ToString('o')
    executablePath = [System.IO.Path]::GetFullPath($ExecutablePath)
    kind = $Kind
  }
}

function Save-State($State) {
  $State | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Stop-StartedProcesses {
  for ($index = $startedProcesses.Count - 1; $index -ge 0; $index--) {
    $process = $startedProcesses[$index]
    if (-not $process) { continue }
    try {
      if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
        [void]$process.WaitForExit(3000)
      }
    } catch {
      Write-Warning "시작 실패 정리 중 PID $($process.Id) 종료 실패: $_"
    }
  }
}

if (Test-Path -LiteralPath $statePath) {
  $previousState = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
  $activePids = @($previousState.server, $previousState.host, $previousState.viewer) |
    Where-Object { $_ -and (Get-Process -Id ([int]$_.pid) -ErrorAction SilentlyContinue) } |
    ForEach-Object { $_.pid }
  if ($activePids.Count -gt 0) {
    throw "이미 실행 중인 시연이 있습니다. 먼저 STOP-HARDWARE-DEMO.cmd를 실행하세요. PID: $($activePids -join ', ')"
  }
  Remove-Item -LiteralPath $statePath -Force
}

& $preflightScript -Port $Port -ServerOnly:$ServerOnly -ReuseExistingRelay:$ReuseExistingRelay -AppExecutable $AppExecutable

New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
$logsPath = Join-Path $RuntimeRoot 'logs'
New-Item -ItemType Directory -Path $logsPath -Force | Out-Null
$nodePath = (Get-Command node -ErrorAction Stop).Source
$relayUrl = "http://127.0.0.1:$Port"
$relayAlreadyRunning = $false
try {
  $existingHealth = Invoke-RestMethod -Uri "$relayUrl/healthz" -TimeoutSec 1
  $relayAlreadyRunning = $ReuseExistingRelay -and $existingHealth.ok -eq $true
} catch {
  $relayAlreadyRunning = $false
}

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
$localSecret = -join ($randomBytes | ForEach-Object { $_.ToString('x2') })

$server = $null
if (-not $relayAlreadyRunning) {
  try {
    $env:HAPTIC_RELAY_HOST = '127.0.0.1'
    $env:HAPTIC_RELAY_PORT = [string]$Port
    $env:HAPTIC_PUBLIC_RELAY_URL = $relayUrl
    $env:HAPTIC_CONTROL_TOKEN_SECRET = $localSecret

    $server = Start-Process -FilePath $nodePath `
      -ArgumentList @($serverScript) `
      -WorkingDirectory $root `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logsPath 'relay.stdout.log') `
      -RedirectStandardError (Join-Path $logsPath 'relay.stderr.log') `
      -PassThru
    $startedProcesses += $server
  } finally {
    foreach ($name in $environmentNames) {
      [System.Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
  }
}

$state = [ordered]@{
  startedAtUtc = [DateTime]::UtcNow.ToString('o')
  relayUrl = $relayUrl
  runtimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
  ownsRelay = -not $relayAlreadyRunning
  server = if ($server) { Get-ProcessRecord $server $nodePath 'server' } else { $null }
  host = $null
  viewer = $null
}
Save-State $state

try {
  $healthy = $false
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    if ($server -and $server.HasExited) {
      $errorLog = Join-Path $logsPath 'relay.stderr.log'
      $details = if (Test-Path -LiteralPath $errorLog) { Get-Content -Raw -LiteralPath $errorLog } else { '' }
      throw "릴레이 서버가 시작 중 종료됐습니다. $details"
    }
    try {
      $health = Invoke-RestMethod -Uri "$relayUrl/healthz" -TimeoutSec 1
      if ($health.ok -eq $true) {
        $healthy = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 100
    }
  }
  if (-not $healthy) { throw '릴레이 서버 health 확인 시간이 초과됐습니다.' }

  if (-not $ServerOnly) {
    $hostProfile = Join-Path $RuntimeRoot 'host-profile'
    $viewerProfile = Join-Path $RuntimeRoot 'viewer-profile'
    New-Item -ItemType Directory -Path $hostProfile, $viewerProfile -Force | Out-Null

    $hostProcess = Start-Process -FilePath $AppExecutable -ArgumentList "--user-data-dir=$hostProfile" -PassThru
    $startedProcesses += $hostProcess
    $viewerProcess = Start-Process -FilePath $AppExecutable -ArgumentList "--user-data-dir=$viewerProfile" -PassThru
    $startedProcesses += $viewerProcess

    $state.host = Get-ProcessRecord $hostProcess $AppExecutable 'app'
    $state.viewer = Get-ProcessRecord $viewerProcess $AppExecutable 'app'
    Save-State $state
  }

  Write-Host ''
  Write-Host '시연 준비 완료' -ForegroundColor Green
  Write-Host "Server URL: $relayUrl"
  if ($relayAlreadyRunning) { Write-Host 'Relay: 기존 정상 서버 재사용 (STOP에서 종료하지 않음)' }
  Write-Host "Runtime: $RuntimeRoot"
  if (-not $ServerOnly) {
    Write-Host '첫 번째 창: 스트리머로 로그인 후 방을 만듭니다.'
    Write-Host '두 번째 창: 시청자로 로그인 후 같은 방에 들어가 장비를 연결합니다.'
  }
  Write-Host '종료할 때 demo\STOP-HARDWARE-DEMO.cmd를 실행하세요.'
  Write-Host ''
} catch {
  Stop-StartedProcesses
  if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Force }
  throw
}
