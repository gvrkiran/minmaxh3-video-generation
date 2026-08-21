# Keep Kathalu Studio up without anyone watching it.
#
# Why this exists: everything start-h3-studio.ps1 launches becomes a child of whichever shell
# ran it. Started from a terminal -- or from a Claude Code tool call -- the whole tree dies
# when that session is torn down, silently and with empty error logs. Her render died that
# way mid-film. Task Scheduler owns this instead, so nothing here belongs to a session that
# can go away.
#
# Safe to run every few minutes: start-h3-studio.ps1 tests each port before starting
# anything, so a healthy service is left strictly alone. It never touches a running render --
# those are separate processes and are not its business.
#
# Register it with scripts/install-watchdog.ps1.

$studioRoot = "H:\KathaluStudio\app"
$logRoot    = Join-Path $studioRoot "work"
$logFile    = Join-Path $logRoot "watchdog.log"
$stateFile  = Join-Path $logRoot "health.json"

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

function Note([string]$text) {
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $text
  Add-Content -LiteralPath $logFile -Value $line -Encoding utf8
}

function PortUp([int]$port) {
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

$services = @(
  @{ name = "comfyui"; port = 8188; what = "the picture and video model" }
  @{ name = "voice";   port = 8190; what = "the Telugu voice" }
  @{ name = "web";     port = 3000; what = "the website she uses" }
)

$before = @{}
foreach ($s in $services) { $before[$s.name] = PortUp $s.port }
$down = @($services | Where-Object { -not $before[$_.name] })

if ($down.Count -gt 0) {
  Note ("DOWN: " + (($down | ForEach-Object { "$($_.name)($($_.port))" }) -join ", ") + " -- starting")
  try {
    # Idempotent: it only starts what is not already listening.
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $studioRoot "scripts\start-h3-studio.ps1") *>&1 |
      ForEach-Object { Note "  start: $_" }
  } catch {
    Note "  start FAILED: $($_.Exception.Message)"
  }

  # Models take a while to load, so give them time before judging the result.
  $deadline = (Get-Date).AddSeconds(240)
  while ((Get-Date) -lt $deadline) {
    if (-not ($services | Where-Object { -not (PortUp $_.port) })) { break }
    Start-Sleep -Seconds 5
  }
  foreach ($s in $services) {
    if (-not $before[$s.name]) {
      Note ("  {0}: {1}" -f $s.name, $(if (PortUp $s.port) { "back up" } else { "STILL DOWN" }))
    }
  }
}

# A snapshot the website can read, so "is it working" is answerable without a terminal.
$renders = @()
foreach ($lock in Get-ChildItem "H:\KathaluStudio\stories\*\pipeline.lock" -ErrorAction SilentlyContinue) {
  try {
    $held = Get-Content -LiteralPath $lock.FullName -Raw | ConvertFrom-Json
    $alive = [bool](Get-Process -Id $held.pid -ErrorAction SilentlyContinue)
    $renders += [ordered]@{ story = $lock.Directory.Name; pid = $held.pid; alive = $alive }
  } catch { }
}

$health = [ordered]@{
  checkedAt = (Get-Date).ToString("o")
  services  = [ordered]@{}
  renders   = $renders
}
foreach ($s in $services) {
  $health.services[$s.name] = [ordered]@{
    port = $s.port; up = (PortUp $s.port); what = $s.what
  }
}
$health | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $stateFile -Encoding utf8

# One heartbeat line an hour is enough to prove the watchdog itself is alive, without the log
# growing without bound.
if ($down.Count -eq 0 -and (Get-Date).Minute -lt 5) { Note "all up" }

# Keep the log from growing forever.
if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 2MB) {
  $keep = Get-Content -LiteralPath $logFile -Tail 2000
  Set-Content -LiteralPath $logFile -Value $keep -Encoding utf8
}
