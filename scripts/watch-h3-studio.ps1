$ErrorActionPreference = "Continue"

$studioRoot = "C:\Users\kg766\Documents\Codex\2026-08-13\can-you"
$startScript = Join-Path $studioRoot "scripts\start-h3-studio.ps1"
$logPath = Join-Path $studioRoot "work\h3-watchdog.log"
$tailscaleExe = "C:\Program Files\Tailscale\tailscale.exe"

function Test-H3Port {
  param([string]$ComputerName, [int]$Port, [int]$TimeoutMilliseconds = 750)
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connection = $client.BeginConnect($ComputerName, $Port, $null, $null)
    if (-not $connection.AsyncWaitHandle.WaitOne($TimeoutMilliseconds)) { return $false }
    $client.EndConnect($connection)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

while ($true) {
  try {
    $candidate = & $tailscaleExe ip -4 2>$null | Select-Object -First 1
    $studioHost = if ($candidate) { $candidate.Trim() } else { $null }
    $comfyOnline = Test-H3Port -ComputerName "127.0.0.1" -Port 8188
    $narrationOnline = Test-H3Port -ComputerName "127.0.0.1" -Port 8190
    $siteOnline = $studioHost -and (Test-H3Port -ComputerName $studioHost -Port 3000)
    if (-not $comfyOnline -or -not $narrationOnline -or -not $siteOnline) {
      $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
      Add-Content -LiteralPath $logPath -Value "$timestamp restarting unavailable H3 services (site=$siteOnline comfy=$comfyOnline narration=$narrationOnline)"
      & $startScript
    }
  } catch {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $logPath -Value "$timestamp watchdog error: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 15
}
