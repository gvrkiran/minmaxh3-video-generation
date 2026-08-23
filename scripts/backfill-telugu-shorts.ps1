# One-shot: give every finished film its 30-second Telugu short.
# Each one needs IndicF5, which is a GPU model, so they queue behind whatever is rendering.
# Run through Task Scheduler so it is not a child of any shell -- a backfill that waits an
# hour for the graphics card must outlive the session that started it.
$ErrorActionPreference = "Continue"
$log = "H:\KathaluStudio\app\work\backfill-te.log"
$secretFile = "H:\KathaluStudio\app\work\secrets\openai-api-key.xml"
$secret = Import-Clixml -LiteralPath $secretFile
$env:OPENAI_API_KEY = (New-Object System.Management.Automation.PSCredential("openai", $secret)).GetNetworkCredential().Password
$env:PYTHONIOENCODING = "utf-8"
"=== started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Add-Content $log -Encoding utf8
& "H:\KathaluStudio\ocr-venv\Scripts\python.exe" -u `
  "H:\KathaluStudio\app\services\kathalu\render\backfill_variants.py" --kinds "short:te" *>&1 |
  Add-Content $log -Encoding utf8
"=== finished $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') exit=$LASTEXITCODE ===" | Add-Content $log -Encoding utf8
