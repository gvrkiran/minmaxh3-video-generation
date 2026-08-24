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

# How long to wait for models to load before recording whether the heal worked. Kept well
# inside the five-minute schedule so two runs cannot overlap.
$confirmSeconds = 90

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

$services = @(
  @{ name = "comfyui"; port = 8188; what = "the picture and video model" }
  @{ name = "voice";   port = 8190; what = "the Telugu voice" }
  @{ name = "web";     port = 3000; what = "the website she uses" }
)

function Note([string]$text) {
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $text
  Add-Content -LiteralPath $logFile -Value $line -Encoding utf8
}

function PortUp([int]$port) {
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

# A snapshot the website can read, so "is it working" is answerable without a terminal.
#
# Called before healing as well as after. The first version wrote it only at the very end,
# after the wait for models to load -- so for those minutes the health page reported the
# watchdog as stale, which is exactly when somebody is most likely to be looking at it and
# least helped by a wrong answer.
function WriteSnapshot {
  $renders = @()
  foreach ($lock in Get-ChildItem "H:\KathaluStudio\stories\*\pipeline.lock" -ErrorAction SilentlyContinue) {
    try {
      $held = Get-Content -LiteralPath $lock.FullName -Raw | ConvertFrom-Json
      $renders += [ordered]@{
        story = $lock.Directory.Name
        pid   = $held.pid
        alive = [bool](Get-Process -Id $held.pid -ErrorAction SilentlyContinue)
      }
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
}

$before = @{}
foreach ($s in $services) { $before[$s.name] = PortUp $s.port }
$down = @($services | Where-Object { -not $before[$_.name] })

WriteSnapshot        # first, so the health page is fresh even if the heal below takes minutes

if ($down.Count -gt 0) {
  Note ("DOWN: " + (($down | ForEach-Object { "$($_.name)($($_.port))" }) -join ", ") + " -- starting")
  # Fire and forget. The first version piped the starter through ForEach-Object to log its
  # output, and that pipeline blocked for over eight minutes -- it waits on handles the
  # started services inherit, not just on the starter exiting. The watchdog does not need
  # its output: it has its own port checks, and the starter already writes its own logs.
  $starter = Join-Path $studioRoot 'scripts\start-h3-studio.ps1'
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $starter) `
    -RedirectStandardOutput (Join-Path $logRoot 'watchdog-start.out.log') `
    -RedirectStandardError  (Join-Path $logRoot 'watchdog-start.err.log')

  $deadline = (Get-Date).AddSeconds($confirmSeconds)
  while ((Get-Date) -lt $deadline) {
    if (-not ($services | Where-Object { -not (PortUp $_.port) })) { break }
    Start-Sleep -Seconds 5
  }
  foreach ($s in $services) {
    if (-not $before[$s.name]) {
      # "still starting" rather than "failed": ComfyUI can take longer than the confirm
      # window to load its models, and the next pass five minutes from now will say for sure.
      Note ("  {0}: {1}" -f $s.name, $(if (PortUp $s.port) { "back up" } else { "still starting" }))
    }
  }
  WriteSnapshot
}

# ---------------------------------------------------------------- interrupted films
#
# A render whose driver is gone but which has no finished film is not going to restart
# itself. This has now happened three times, always the same way: an empty .err file, so
# nothing crashed -- the process was killed. Node spawns the driver with detached:true, which
# on Windows does not survive the parent's job object, so anything that takes down the web app
# takes the render with it, seventeen shots into eighteen.
#
# Rather than chase Windows process semantics, make it recoverable. Resuming is free: the
# pipeline skips every shot already on disk, so it picks up exactly where it stopped.
$stories = "H:\KathaluStudio\stories"
foreach ($lock in Get-ChildItem "$stories\*\pipeline.lock" -ErrorAction SilentlyContinue) {
  $dir = $lock.Directory
  if (Test-Path (Join-Path $dir.FullName "final.mp4")) { continue }
  try { $held = Get-Content -LiteralPath $lock.FullName -Raw | ConvertFrom-Json } catch { continue }
  if (Get-Process -Id $held.pid -ErrorAction SilentlyContinue) { continue }

  # Only if there is actually something to resume -- a scene plan and at least one shot.
  if (-not (Test-Path (Join-Path $dir.FullName "script.json"))) { continue }

  $aspect = "9:16"
  $statePath = Join-Path $dir.FullName "state.json"
  if (Test-Path $statePath) {
    try { $aspect = (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json).aspect } catch { }
    if (-not $aspect) { $aspect = "9:16" }
  }
  Note "INTERRUPTED: $($dir.Name) (driver $($held.pid) is gone, no final.mp4) -- resuming"
  $body = @{ storyDir = ($dir.FullName -replace '\', '/'); aspect = $aspect; voice = "female" } |
          ConvertTo-Json -Compress
  try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/story/render" -Method Post `
              -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 60
    Note "  resume requested for $($dir.Name)"
  } catch {
    Note "  could not resume $($dir.Name): $($_.Exception.Message)"
  }
}

# One heartbeat line an hour proves the watchdog itself is alive without the log growing
# without bound.
if ($down.Count -eq 0 -and (Get-Date).Minute -lt 5) { Note "all up" }

if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 2MB) {
  $keep = Get-Content -LiteralPath $logFile -Tail 2000
  Set-Content -LiteralPath $logFile -Value $keep -Encoding utf8
}
