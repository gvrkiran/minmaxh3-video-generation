$ErrorActionPreference = "Stop"

$studioRoot = "C:\Users\kg766\Documents\Codex\2026-08-13\can-you"
$logRoot = Join-Path $studioRoot "work"
$stdoutLog = Join-Path $logRoot "h3-studio.stdout.log"
$stderrLog = Join-Path $logRoot "h3-studio.stderr.log"
$tailscaleExe = "C:\Program Files\Tailscale\tailscale.exe"
$geminiSecretFile = Join-Path $logRoot "secrets\gemini-api-key.xml"
$openaiSecretFile = Join-Path $logRoot "secrets\openai-api-key.xml"

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
Set-Location -LiteralPath $studioRoot

if (Test-Path -LiteralPath $geminiSecretFile) {
  $geminiSecret = Import-Clixml -LiteralPath $geminiSecretFile
  $geminiCredential = New-Object System.Management.Automation.PSCredential("gemini", $geminiSecret)
  $env:GEMINI_API_KEY = $geminiCredential.GetNetworkCredential().Password
}

# Kathalu Studio (/story) needs this for reading pages, casting, scripting and the Telugu.
if (Test-Path -LiteralPath $openaiSecretFile) {
  $openaiSecret = Import-Clixml -LiteralPath $openaiSecretFile
  $openaiCredential = New-Object System.Management.Automation.PSCredential("openai", $openaiSecret)
  $env:OPENAI_API_KEY = $openaiCredential.GetNetworkCredential().Password
}

if (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port 8188 -InformationLevel Quiet -WarningAction SilentlyContinue)) {
  $comfyRoot = "C:\Users\kg766\ComfyUI-Installs\ComfyUI real"
  $comfyPython = Join-Path $comfyRoot "ComfyUI\.venv\Scripts\python.exe"
  $comfyArguments = '-s ComfyUI\main.py --feature-flag show_signin_button=true --enable-manager --extra-model-paths-config "C:\Users\kg766\AppData\Roaming\Comfy Desktop\shared_model_paths.yaml" --input-directory "C:\Users\kg766\Downloads\ComfyUI\input" --output-directory "C:\Users\kg766\Downloads\ComfyUI\output"'
  Start-Process -FilePath $comfyPython `
    -ArgumentList $comfyArguments `
    -WorkingDirectory $comfyRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logRoot "comfy-remote.stdout.log") `
    -RedirectStandardError (Join-Path $logRoot "comfy-remote.stderr.log")
}

if (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port 8190 -InformationLevel Quiet -WarningAction SilentlyContinue)) {
  $indicRoot = "H:\H3RemoteStudio\IndicF5"
  $indicPython = Join-Path $indicRoot "venv\Scripts\python.exe"
  $env:HF_HOME = Join-Path $indicRoot "hf-cache"
  $env:HF_HUB_CACHE = Join-Path $env:HF_HOME "hub"
  $env:HF_TOKEN_PATH = "C:\Users\kg766\.cache\huggingface\token"
  $env:TEMP = Join-Path $indicRoot "tmp"
  $env:TMP = $env:TEMP
  $env:H3_STUDIO_ROOT = $studioRoot
  $env:COMFY_OUTPUT_ROOT = "C:\Users\kg766\Downloads\ComfyUI\output"
  Start-Process -FilePath $indicPython `
    -ArgumentList @((Join-Path $studioRoot "services\indicf5\service.py")) `
    -WorkingDirectory $studioRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logRoot "indicf5.stdout.log") `
    -RedirectStandardError (Join-Path $logRoot "indicf5.stderr.log")
}

$studioHost = $null
# Tailscale can take a few minutes to reconnect immediately after sign-in.
for ($attempt = 0; $attempt -lt 150 -and -not $studioHost; $attempt++) {
  $candidate = & $tailscaleExe ip -4 2>$null | Select-Object -First 1
  $studioHost = if ($candidate) { $candidate.Trim() } else { $null }
  if (-not $studioHost) { Start-Sleep -Seconds 2 }
}
if (-not $studioHost) { throw "Tailscale is not connected." }

if (-not (Test-NetConnection -ComputerName $studioHost -Port 3000 -InformationLevel Quiet -WarningAction SilentlyContinue)) {
  Start-Process -FilePath (Join-Path $studioRoot "node_modules\.bin\vinext.cmd") `
    -ArgumentList @("start", "--hostname", $studioHost) `
    -WorkingDirectory $studioRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog
}
