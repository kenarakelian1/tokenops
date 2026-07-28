# TokenOps agent uninstaller
$ErrorActionPreference = "Stop"

$InstallDir = Join-Path $env:LOCALAPPDATA "TokenOps\agent"
$BinDir = Join-Path $env:LOCALAPPDATA "TokenOps\bin"
$TokenOpsRoot = Join-Path $env:LOCALAPPDATA "TokenOps"
$StartMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\TokenOps"
$Desktop = [Environment]::GetFolderPath("Desktop")
$DesktopLnk = Join-Path $Desktop "TokenOps Agent.lnk"
$ClaudeLnk = Join-Path $Desktop "Claude Code + TokenOps.cmd"
$taskName = "TokenOpsAgent"
$ManifestPath = Join-Path $TokenOpsRoot "install-manifest.json"

Write-Host "Uninstalling TokenOps agent…" -ForegroundColor Cyan

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

# Remove env vars we set (from manifest only — does not wipe unrelated user secrets)
if (Test-Path $ManifestPath) {
  try {
    $manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
    $tokenopsOtelVars = @(
      "CLAUDE_CODE_ENABLE_TELEMETRY",
      "OTEL_METRICS_EXPORTER",
      "OTEL_EXPORTER_OTLP_PROTOCOL",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OPENAI_BASE_URL",
      "OPENAI_API_BASE"
    )
    foreach ($name in $manifest.envVars) {
      # Only auto-clear vars TokenOps owns; leave OPENAI_API_KEY / XAI_API_KEY
      # unless user confirms (keys may be shared with other apps).
      if ($tokenopsOtelVars -contains $name) {
        [Environment]::SetEnvironmentVariable($name, $null, "User")
        Write-Host "   Cleared user env $name"
      }
    }
    if ($manifest.envVars -contains "OPENAI_API_KEY" -or $manifest.envVars -contains "XAI_API_KEY") {
      Write-Host "   Left OPENAI_API_KEY / XAI_API_KEY in place (may be used by other apps)." -ForegroundColor Yellow
      Write-Host "   Remove them manually in System Properties → Environment if desired." -ForegroundColor Yellow
    }
  } catch {
    Write-Host "   Could not parse install-manifest.json: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
if (Test-Path $BinDir) { Remove-Item -Recurse -Force $BinDir }
if (Test-Path $StartMenuDir) { Remove-Item -Recurse -Force $StartMenuDir }
if (Test-Path $DesktopLnk) { Remove-Item -Force $DesktopLnk }
if (Test-Path $ClaudeLnk) { Remove-Item -Force $ClaudeLnk }
if (Test-Path $ManifestPath) { Remove-Item -Force $ManifestPath }

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath) {
  $parts = $userPath -split ";" | Where-Object { $_ -and ($_ -ne $BinDir) }
  [Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")
}

if ((Test-Path $TokenOpsRoot) -and -not (Get-ChildItem $TokenOpsRoot -Force -ErrorAction SilentlyContinue)) {
  Remove-Item -Force $TokenOpsRoot -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Agent removed. Config kept at: $env:USERPROFILE\.tokenops" -ForegroundColor Green
Write-Host "(Delete that folder manually for a full wipe.)"
Write-Host ""
