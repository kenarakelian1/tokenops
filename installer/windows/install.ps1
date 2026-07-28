# TokenOps desktop agent installer (Windows)
# Run via install.cmd (recommended) so ExecutionPolicy is bypassed.
#Requires -Version 5.1
param(
  [switch]$NoStartup
)
$ErrorActionPreference = "Stop"

$InstallerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PayloadAgent = Join-Path $InstallerRoot "payload\agent"
$InstallDir = Join-Path $env:LOCALAPPDATA "TokenOps\agent"
$ConfigDir = Join-Path $env:USERPROFILE ".tokenops"
$StartMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\TokenOps"
$Desktop = [Environment]::GetFolderPath("Desktop")

function Write-Step($msg) { Write-Host ">> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "   $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "   $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  TokenOps Agent Installer" -ForegroundColor White
Write-Host "  ========================" -ForegroundColor White
Write-Host ""

# --- Node.js check ---
Write-Step "Checking Node.js (need 22+)…"
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js was not found on PATH." -ForegroundColor Red
  Write-Host "Install Node.js 22 LTS from https://nodejs.org/ then re-run install.cmd"
  exit 1
}
$verRaw = & node.exe -v
$ver = $verRaw.TrimStart("v")
$major = [int]($ver.Split(".")[0])
if ($major -lt 22) {
  Write-Host "Node.js $verRaw found; TokenOps needs Node 22+ (uses node:sqlite)." -ForegroundColor Red
  exit 1
}
Write-Ok "Found Node $verRaw at $($node.Source)"

# --- Payload ---
if (-not (Test-Path (Join-Path $PayloadAgent "dist\cli.js"))) {
  Write-Host "Missing payload\agent\dist\cli.js" -ForegroundColor Red
  Write-Host "This folder is incomplete. Rebuild with: node scripts/package-agent.mjs"
  exit 1
}

# --- Copy files ---
Write-Step "Installing to $InstallDir"
if (Test-Path $InstallDir) {
  Remove-Item -Recurse -Force $InstallDir
}
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item -Path (Join-Path $PayloadAgent "*") -Destination $InstallDir -Recurse -Force
Write-Ok "Files copied"

# --- Launcher tokenops.cmd (no PowerShell / pnpm) ---
$launcher = @"
@echo off
setlocal
set "TOKENOPS_HOME=%InstallDir%"
node "%TOKENOPS_HOME%\dist\cli.js" %*
"@
# Expand InstallDir into the batch file
$launcher = "@echo off`r`nsetlocal`r`nset `"TOKENOPS_HOME=$InstallDir`"`r`nnode `"%TOKENOPS_HOME%\dist\cli.js`" %*`r`n"
Set-Content -Path (Join-Path $InstallDir "tokenops.cmd") -Value $launcher -Encoding ASCII

# User-local bin on PATH
$BinDir = Join-Path $env:LOCALAPPDATA "TokenOps\bin"
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
$binLauncher = "@echo off`r`nsetlocal`r`nset `"TOKENOPS_HOME=$InstallDir`"`r`nnode `"%TOKENOPS_HOME%\dist\cli.js`" %*`r`n"
Set-Content -Path (Join-Path $BinDir "tokenops.cmd") -Value $binLauncher -Encoding ASCII

# Add BinDir to user PATH if missing
Write-Step "Updating user PATH…"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) { $userPath = "" }
$pathParts = $userPath -split ";" | Where-Object { $_ -ne "" }
if ($pathParts -notcontains $BinDir) {
  $newPath = ($pathParts + $BinDir) -join ";"
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  $env:Path = "$BinDir;$env:Path"
  Write-Ok "Added $BinDir to user PATH (open a new terminal to pick it up)"
} else {
  Write-Ok "PATH already contains $BinDir"
}

# --- Config ---
Write-Step "Config at $ConfigDir"
if (-not (Test-Path $ConfigDir)) {
  New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
}
$configPath = Join-Path $ConfigDir "config.toml"
if (-not (Test-Path $configPath)) {
  & node.exe (Join-Path $InstallDir "dist\cli.js") init
  Write-Ok "Created default config.toml"
} else {
  Write-Ok "Keeping existing config.toml"
}

# --- Shortcuts ---
Write-Step "Start Menu shortcuts…"
New-Item -ItemType Directory -Path $StartMenuDir -Force | Out-Null

$ws = New-Object -ComObject WScript.Shell

function New-Shortcut($path, $target, $args, $workDir, $desc) {
  $sc = $ws.CreateShortcut($path)
  $sc.TargetPath = $target
  if ($args) { $sc.Arguments = $args }
  $sc.WorkingDirectory = $workDir
  $sc.Description = $desc
  $sc.Save()
}

$cmdExe = Join-Path $env:SystemRoot "System32\cmd.exe"
$runArgs = "/k `"$InstallDir\tokenops.cmd`" agent run"
New-Shortcut (Join-Path $StartMenuDir "TokenOps Agent.lnk") $cmdExe $runArgs $InstallDir "Start TokenOps agent (proxy + OTEL + flush)"
New-Shortcut (Join-Path $StartMenuDir "TokenOps Status.lnk") $cmdExe "/k `"$InstallDir\tokenops.cmd`" status" $InstallDir "Show agent status"
New-Shortcut (Join-Path $StartMenuDir "TokenOps Config Folder.lnk") "explorer.exe" $ConfigDir $ConfigDir "Open ~/.tokenops"
New-Shortcut (Join-Path $Desktop "TokenOps Agent.lnk") $cmdExe $runArgs $InstallDir "Start TokenOps agent"

Write-Ok "Start Menu + Desktop shortcuts created"

# --- Optional logon task ---
$taskName = "TokenOpsAgent"
if (-not $NoStartup) {
  Write-Step "Registering logon startup task ($taskName)…"
  $action = New-ScheduledTaskAction -Execute $cmdExe -Argument "/c `"$InstallDir\tokenops.cmd`" agent run" -WorkingDirectory $InstallDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-Ok "Will start at logon (Task Scheduler: $taskName). Use install.cmd -NoStartup to skip."
  } catch {
    Write-Warn "Could not create scheduled task: $($_.Exception.Message)"
  }
} else {
  Write-Ok "Skipped logon task (-NoStartup)"
}

Write-Host ""
Write-Host "  Install complete." -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor White
Write-Host "  1. Open the dashboard and create a PAT:"
Write-Host "     https://tokenops-web-production.up.railway.app"
Write-Host "  2. Edit config:  $configPath"
Write-Host "       [cloud]"
Write-Host "       url = `"https://tokenops-api-production.up.railway.app`""
Write-Host "       ingest_token = `"tok_...`""
Write-Host "  3. Start agent:  Start Menu → TokenOps Agent"
Write-Host "     or:           tokenops agent run"
Write-Host "  4. Optional proxy key:  set OPENAI_API_KEY=sk-..."
Write-Host ""
Write-Host "  Status:  tokenops status"
Write-Host "  Uninstall: uninstall.cmd"
Write-Host ""
