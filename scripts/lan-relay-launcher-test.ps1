$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'start-lan-relay.ps1'
$runtimeRoot = Join-Path ([System.IO.Path]::GetTempPath()) "haptic-relay-lan-launcher-test-$PID"
$probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$probe.Start()
$port = ([System.Net.IPEndPoint]$probe.LocalEndpoint).Port
$probe.Stop()
$publicRelayUrl = "http://192.168.219.105:$port"
$statePath = Join-Path $runtimeRoot 'state.json'
$failure = $null

try {
  & $launcher -Port $port -PublicRelayUrl $publicRelayUrl -RuntimeRoot $runtimeRoot

  $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
  if ($state.publicRelayUrl -ne $publicRelayUrl) {
    throw "state public URL mismatch: $($state.publicRelayUrl)"
  }

  $roomName = "lan-launcher-$PID"
  $body = @{ roomName = $roomName; password = 'secret'; entryMode = 'open' } | ConvertTo-Json
  $room = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/rooms" -ContentType 'application/json' -Body $body
  if ($room.relayUrl -ne $publicRelayUrl) {
    throw "room relay URL mismatch: $($room.relayUrl)"
  }

  Write-Output 'LAN relay launcher test passed'
} catch {
  $failure = $_
} finally {
  if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    $process = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
    if ($process) {
      Stop-Process -Id $process.Id -Force
      Wait-Process -Id $process.Id -ErrorAction SilentlyContinue
    }
  }

  $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $resolvedRuntime = [System.IO.Path]::GetFullPath($runtimeRoot)
  if ($resolvedRuntime.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedRuntime)) {
    Remove-Item -LiteralPath $resolvedRuntime -Recurse -Force
  }
}

if ($failure) { throw $failure }
