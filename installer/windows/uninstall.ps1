# TokenOps agent uninstaller
$ErrorActionPreference = "Stop"

$InstallDir = Join-Path $env:LOCALAPPDATA "TokenOps\agent"
$BinDir = Join-Path $env:LOCALAPPDATA "TokenOps\bin"
$StartMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\TokenOps"
$DesktopLnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "TokenOps Agent.lnk"
$taskName = "TokenOpsAgent"

Write-Host "Uninstalling TokenOps agent…" -ForegroundColor Cyan

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
if (Test-Path $BinDir) { Remove-Item -Recurse -Force $BinDir }
if (Test-Path $StartMenuDir) { Remove-Item -Recurse -Force $StartMenuDir }
if (Test-Path $DesktopLnk) { Remove-Item -Force $DesktopLnk }

# Remove TokenOps\bin from user PATH
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath) {
  $parts = $userPath -split ";" | Where-Object { $_ -and ($_ -ne $BinDir) }
  [Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")
}

# Remove empty TokenOps parent if empty
$parent = Join-Path $env:LOCALAPPDATA "TokenOps"
if ((Test-Path $parent) -and -not (Get-ChildItem $parent -Force -ErrorAction SilentlyContinue)) {
  Remove-Item -Force $parent -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Agent removed. Config kept at: $env:USERPROFILE\.tokenops" -ForegroundColor Green
Write-Host "(Delete that folder manually if you want a full wipe.)"
Write-Host ""
