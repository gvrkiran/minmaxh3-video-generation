# Register the watchdog with Task Scheduler. Run once; safe to re-run.
#
# Two properties are wanted and one task gives both: it starts the studio after a reboot
# (within one interval of logging in) and it puts anything back that has died since.
#
# Task Scheduler is the point. A task is owned by the scheduler service, not by the shell that
# created it, so it survives the terminal closing, Claude Code closing, and being logged out
# and back in. Anything started from a session dies with that session.
#
# Note: no /RL HIGHEST. It requires elevation and fails here with "Access is denied", and
# nothing the studio does needs administrator rights.

$studioRoot = "H:\KathaluStudio\app"
$watchdog   = Join-Path $studioRoot "scripts\watchdog.ps1"
$task       = "KathaluStudioWatchdog"
$every      = 5      # minutes

$command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdog`""

schtasks /Delete /TN $task /F 2>$null | Out-Null
schtasks /Create /TN $task /TR $command /SC MINUTE /MO $every /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "could not register $task" }

Write-Output "registered '$task', every $every minute(s)"
Write-Output ""
schtasks /Query /TN $task /FO LIST | Select-String "TaskName|Status|Next Run|Schedule"
Write-Output ""
Write-Output "check it any time with:"
Write-Output "  http://100.90.163.26:3000/api/story/health"
Write-Output "stop it with:"
Write-Output "  schtasks /Change /TN $task /DISABLE"
