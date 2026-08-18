[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 4174,
  [switch]$ServerOnly,
  [string]$AppExecutable = "$env:LOCALAPPDATA\Programs\Haptic Relay\Haptic Relay.exe"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$serverScript = Join-Path $root 'dist-server\server\src\relay-server.js'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue

if (-not $nodeCommand) {
  throw 'Node.js를 찾을 수 없습니다.'
}
if (-not (Test-Path -LiteralPath $serverScript)) {
  throw "릴레이 서버 빌드가 없습니다: $serverScript"
}
if (-not $ServerOnly -and -not (Test-Path -LiteralPath $AppExecutable)) {
  throw "Haptic Relay 설치본을 찾을 수 없습니다: $AppExecutable"
}

$relayAlreadyRunning = $false
try {
  $existingHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 1
  $relayAlreadyRunning = $existingHealth.ok -eq $true
} catch {
  $relayAlreadyRunning = $false
}

if (-not $relayAlreadyRunning) {
  $existingListener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($existingListener) {
    throw "로컬 포트 $Port 를 다른 프로세스가 사용 중이며 Haptic Relay health 응답이 없습니다."
  }

  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $listener.Server.ExclusiveAddressUse = $true
    $listener.Start()
  } catch {
    throw "로컬 포트 $Port 를 사용할 수 없습니다. 기존 시연을 먼저 종료하거나 다른 포트를 지정하세요."
  } finally {
    if ($listener) { $listener.Stop() }
  }
}

$ports = [System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object

Write-Host ''
Write-Host 'Haptic Relay 현장 사전 점검' -ForegroundColor Cyan
Write-Host "[OK] Node.js: $($nodeCommand.Source)"
Write-Host "[OK] Relay build: $serverScript"
if ($relayAlreadyRunning) {
  Write-Host "[OK] Existing relay: http://127.0.0.1:$Port"
} else {
  Write-Host "[OK] Local port available: $Port"
}
if (-not $ServerOnly) {
  Write-Host "[OK] Installed app: $AppExecutable"
}
if ($ports.Count -gt 0) {
  Write-Host "[INFO] 현재 COM 포트: $($ports -join ', ')"
} else {
  Write-Host '[INFO] 현재 COM 포트 없음. 장비 연결 후 앱에서 새로고침하세요.'
}
Write-Host ''
