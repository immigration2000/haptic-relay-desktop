[CmdletBinding()]
param(
  [string]$RuntimeRoot = (Join-Path ([System.IO.Path]::GetTempPath()) 'HapticRelayHardwareDemo')
)

$ErrorActionPreference = 'Stop'
$statePath = Join-Path $RuntimeRoot 'state.json'

if (-not (Test-Path -LiteralPath $statePath)) {
  Write-Host '실행 중인 Haptic Relay 현장 시연 기록이 없습니다.'
  exit 0
}

$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json

function Stop-RecordedProcess($Record) {
  if (-not $Record) { return }

  $process = Get-Process -Id ([int]$Record.pid) -ErrorAction SilentlyContinue
  if (-not $process) {
    Write-Host "[OK] 이미 종료됨: $($Record.kind) PID $($Record.pid)"
    return
  }

  $actualStart = $process.StartTime.ToUniversalTime().ToString('o')
  if ($actualStart -ne [string]$Record.startedAtUtc) {
    Write-Warning "PID $($Record.pid)의 시작 시각이 달라 종료하지 않습니다."
    return
  }

  if ($Record.kind -eq 'app') {
    [void]$process.CloseMainWindow()
    if ($process.WaitForExit(3000)) {
      Write-Host "[OK] 앱 종료: PID $($Record.pid)"
      return
    }
  }

  Stop-Process -Id $process.Id -Force -ErrorAction Stop
  if (-not $process.WaitForExit(3000)) {
    throw "프로세스 종료 확인 시간이 초과됐습니다: $($Record.kind) PID $($Record.pid)"
  }
  Write-Host "[OK] 프로세스 종료: $($Record.kind) PID $($Record.pid)"
}

Stop-RecordedProcess $state.viewer
Stop-RecordedProcess $state.host
Stop-RecordedProcess $state.server
Remove-Item -LiteralPath $statePath -Force
Write-Host 'Haptic Relay 현장 시연을 종료했습니다.'
