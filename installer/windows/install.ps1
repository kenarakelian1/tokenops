# TokenOps desktop agent installer (Windows)
# Run via install.cmd (recommended) so ExecutionPolicy is bypassed.
#Requires -Version 5.1
param(
  # Non-interactive / CI: skip questions and use defaults
  [switch]$Quiet,
  # Force skip logon task even if user would say yes
  [switch]$NoStartup
)
$ErrorActionPreference = "Stop"

$InstallerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PayloadAgent = Join-Path $InstallerRoot "payload\agent"
$InstallDir = Join-Path $env:LOCALAPPDATA "TokenOps\agent"
$BinDir = Join-Path $env:LOCALAPPDATA "TokenOps\bin"
$ConfigDir = Join-Path $env:USERPROFILE ".tokenops"
$StartMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\TokenOps"
$Desktop = [Environment]::GetFolderPath("Desktop")
$ManifestPath = Join-Path $env:LOCALAPPDATA "TokenOps\install-manifest.json"
$DashboardUrl = "https://tokenops-web-production.up.railway.app"
# Agent ships to the dashboard origin: nginx proxies /v1/ to the API, so one URL
# covers both signing in and POST /v1/events + /v1/heartbeats.
$DefaultCloudUrl = $DashboardUrl
$OtelEndpoint = "http://127.0.0.1:4318"
$ProxyListen = "127.0.0.1:8787"

function Write-Step($msg) { Write-Host ">> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "   $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "   $msg" -ForegroundColor Yellow }

function Read-YesNo([string]$Prompt, [bool]$DefaultYes = $true) {
  $suffix = if ($DefaultYes) { "[Y/n]" } else { "[y/N]" }
  while ($true) {
    $r = Read-Host "$Prompt $suffix"
    if ([string]::IsNullOrWhiteSpace($r)) { return $DefaultYes }
    switch -Regex ($r.Trim().ToLowerInvariant()) {
      '^(y|yes)$' { return $true }
      '^(n|no)$' { return $false }
      default { Write-Host "    Please enter Y or N." -ForegroundColor Yellow }
    }
  }
}

function Read-Optional([string]$Prompt) {
  $r = Read-Host $Prompt
  if ([string]::IsNullOrWhiteSpace($r)) { return "" }
  return $r.Trim()
}

function Set-UserEnv([string]$Name, [string]$Value) {
  [Environment]::SetEnvironmentVariable($Name, $Value, "User")
  Set-Item -Path "Env:$Name" -Value $Value
}

function Escape-TomlString([string]$s) {
  if ($null -eq $s) { return "" }
  return ($s -replace '\\', '\\' -replace '"', '\"')
}

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

# ========== Interactive setup ==========
$useClaude = $false
$useCursor = $false
$useGrok = $false
$useOpenAI = $false
$useOtherOai = $false
$wantStartup = -not $NoStartup
$cloudUrl = $DefaultCloudUrl
$ingestToken = ""
$openaiKey = ""
$xaiKey = ""
$machineName = $env:COMPUTERNAME
if ([string]::IsNullOrWhiteSpace($machineName)) { $machineName = "desktop" }

if (-not $Quiet) {
  Write-Host ""
  Write-Host "  Which AI coding tools do you use?" -ForegroundColor White
  Write-Host "  (TokenOps will configure capture for each you pick.)" -ForegroundColor DarkGray
  Write-Host ""
  $useClaude = Read-YesNo "  Claude Code" $true
  $useCursor = Read-YesNo "  Cursor (or other IDE with custom OpenAI base URL)" $false
  $useGrok = Read-YesNo "  Grok / xAI API" $false
  $useOpenAI = Read-YesNo "  OpenAI API (ChatGPT API, SDKs, etc.)" $true
  $useOtherOai = Read-YesNo "  Other OpenAI-compatible tools (point them at the proxy)" $false

  Write-Host ""
  Write-Host "  Cloud / account" -ForegroundColor White
  $urlIn = Read-Optional "  TokenOps API URL [$DefaultCloudUrl]"
  if ($urlIn) { $cloudUrl = $urlIn.TrimEnd("/") }

  Write-Host "  Create a PAT at: $DashboardUrl  → Settings → Create token" -ForegroundColor DarkGray
  $ingestToken = Read-Optional "  Ingest PAT (tok_…, leave blank to set later)"

  if ($useOpenAI -or $useCursor -or $useOtherOai) {
    Write-Host "  Optional: paste OpenAI key for the local proxy (stored as user env OPENAI_API_KEY)" -ForegroundColor DarkGray
    $openaiKey = Read-Optional "  OPENAI_API_KEY (blank to skip)"
  }
  if ($useGrok) {
    Write-Host "  Optional: paste xAI key for Grok via the local proxy (user env XAI_API_KEY)" -ForegroundColor DarkGray
    $xaiKey = Read-Optional "  XAI_API_KEY (blank to skip)"
  }

  $mn = Read-Optional "  Machine display name [$machineName]"
  if ($mn) { $machineName = $mn }

  Write-Host ""
  if ($NoStartup) {
    $wantStartup = $false
    Write-Ok "Startup task disabled (-NoStartup)"
  } else {
    $wantStartup = Read-YesNo "  Start TokenOps agent automatically when Windows signs you in?" $true
  }
} else {
  # Quiet defaults: Claude + OpenAI, Railway cloud, startup unless -NoStartup
  $useClaude = $true
  $useOpenAI = $true
  $wantStartup = -not $NoStartup
}

# Proxy upstream: prefer xAI if Grok-only; OpenAI if both (user can dual later); xAI if only Grok
$upstream = "https://api.openai.com"
$proxyEnabled = $useOpenAI -or $useCursor -or $useOtherOai -or $useGrok
if ($useGrok -and -not ($useOpenAI -or $useCursor -or $useOtherOai)) {
  $upstream = "https://api.x.ai/v1"
} elseif ($useGrok -and ($useOpenAI -or $useCursor -or $useOtherOai)) {
  Write-Warn "OpenAI and Grok both selected: proxy defaults to OpenAI."
  Write-Warn "For Grok, set proxy.upstream = `"https://api.x.ai/v1`" in config and XAI_API_KEY, or run a second profile later."
  $upstream = "https://api.openai.com"
}

$otelListen = if ($useClaude) { "127.0.0.1:4318" } else { "" }
$claudeCode = $useClaude
$openaiProxy = $proxyEnabled

# --- Copy files ---
Write-Step "Installing to $InstallDir"
if (Test-Path $InstallDir) {
  Remove-Item -Recurse -Force $InstallDir
}
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item -Path (Join-Path $PayloadAgent "*") -Destination $InstallDir -Recurse -Force
Write-Ok "Files copied"

# --- Launchers ---
$launcher = "@echo off`r`nsetlocal`r`nset `"TOKENOPS_HOME=$InstallDir`"`r`nnode `"%TOKENOPS_HOME%\dist\cli.js`" %*`r`n"
Set-Content -Path (Join-Path $InstallDir "tokenops.cmd") -Value $launcher -Encoding ASCII

New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
Set-Content -Path (Join-Path $BinDir "tokenops.cmd") -Value $launcher -Encoding ASCII

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

# --- Global user environment (AI tools) ---
Write-Step "Setting user environment variables for selected tools…"
$envVarsSet = @()

if ($useClaude) {
  Set-UserEnv "CLAUDE_CODE_ENABLE_TELEMETRY" "1"
  Set-UserEnv "OTEL_METRICS_EXPORTER" "otlp"
  Set-UserEnv "OTEL_EXPORTER_OTLP_PROTOCOL" "http/json"
  Set-UserEnv "OTEL_EXPORTER_OTLP_ENDPOINT" $OtelEndpoint
  $envVarsSet += @(
    "CLAUDE_CODE_ENABLE_TELEMETRY",
    "OTEL_METRICS_EXPORTER",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_EXPORTER_OTLP_ENDPOINT"
  )
  Write-Ok "Claude Code OTEL → $OtelEndpoint (user env; new terminals inherit this)"
}

if ($useCursor -or $useOtherOai) {
  # Common vars some OpenAI-compatible clients honor
  Set-UserEnv "OPENAI_BASE_URL" "http://$ProxyListen/v1"
  Set-UserEnv "OPENAI_API_BASE" "http://$ProxyListen/v1"
  $envVarsSet += @("OPENAI_BASE_URL", "OPENAI_API_BASE")
  Write-Ok "OPENAI_BASE_URL / OPENAI_API_BASE → http://$ProxyListen/v1"
  Write-Warn "Cursor: also set Settings → Models → OpenAI Base URL to http://$ProxyListen/v1 if the IDE ignores env."
}

if ($openaiKey) {
  Set-UserEnv "OPENAI_API_KEY" $openaiKey
  $envVarsSet += @("OPENAI_API_KEY")
  Write-Ok "OPENAI_API_KEY stored in user environment"
}
if ($xaiKey) {
  Set-UserEnv "XAI_API_KEY" $xaiKey
  $envVarsSet += @("XAI_API_KEY")
  Write-Ok "XAI_API_KEY stored in user environment"
}

# --- Config.toml (always rewrite from wizard choices; preserve old PAT if blank) ---
Write-Step "Writing $ConfigDir\config.toml"
if (-not (Test-Path $ConfigDir)) {
  New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
}
$configPath = Join-Path $ConfigDir "config.toml"

# Preserve existing ingest token if user left blank
if (-not $ingestToken -and (Test-Path $configPath)) {
  $existing = Get-Content $configPath -Raw
  if ($existing -match 'ingest_token\s*=\s*"([^"]+)"') {
    $ingestToken = $Matches[1]
    Write-Ok "Kept existing ingest_token from config"
  }
}

$toml = @"
# Generated by TokenOps installer $(Get-Date -Format o)
[cloud]
url = "$(Escape-TomlString $cloudUrl)"
ingest_token = "$(Escape-TomlString $ingestToken)"

[privacy]
content_mode = "local"
content_ttl_days = 7

[proxy]
listen = "$ProxyListen"
upstream = "$(Escape-TomlString $upstream)"

[sources]
openai_proxy = $(if ($openaiProxy) { "true" } else { "false" })
claude_code = $(if ($claudeCode) { "true" } else { "false" })
claude_code_path = ""
claude_code_otel_listen = "$(Escape-TomlString $otelListen)"

[machine]
name = "$(Escape-TomlString $machineName)"
"@
Set-Content -Path $configPath -Value $toml -Encoding UTF8

# Ensure machine identity exists (stable UUID)
$identityPath = Join-Path $ConfigDir "machine.json"
if (Test-Path $identityPath) {
  try {
    $idObj = Get-Content $identityPath -Raw | ConvertFrom-Json
    if ($idObj.machineName -ne $machineName) {
      $idObj.machineName = $machineName
      ($idObj | ConvertTo-Json) + "`n" | Set-Content -Path $identityPath -Encoding UTF8
    }
  } catch {
    Write-Warn "Could not update machine.json name: $($_.Exception.Message)"
  }
} else {
  $identity = @{
    machineId = [guid]::NewGuid().ToString()
    machineName = $machineName
  }
  ($identity | ConvertTo-Json) + "`n" | Set-Content -Path $identityPath -Encoding UTF8
  Write-Ok "Created machine identity"
}
Write-Ok "Config written"

# Claude helper launcher on Desktop
if ($useClaude) {
  $claudeCmd = @"
@echo off
REM Claude Code with TokenOps OTEL (agent must be running)
set CLAUDE_CODE_ENABLE_TELEMETRY=1
set OTEL_METRICS_EXPORTER=otlp
set OTEL_EXPORTER_OTLP_PROTOCOL=http/json
set OTEL_EXPORTER_OTLP_ENDPOINT=$OtelEndpoint
claude %*
"@
  Set-Content -Path (Join-Path $Desktop "Claude Code + TokenOps.cmd") -Value $claudeCmd -Encoding ASCII
  Write-Ok "Desktop: Claude Code + TokenOps.cmd"
}

# --- Shortcuts ---
Write-Step "Start Menu / Desktop shortcuts…"
New-Item -ItemType Directory -Path $StartMenuDir -Force | Out-Null
$ws = New-Object -ComObject WScript.Shell
function New-Shortcut($path, $target, $arguments, $workDir, $desc) {
  $sc = $ws.CreateShortcut($path)
  $sc.TargetPath = $target
  if ($arguments) { $sc.Arguments = $arguments }
  $sc.WorkingDirectory = $workDir
  $sc.Description = $desc
  $sc.Save()
}
$cmdExe = Join-Path $env:SystemRoot "System32\cmd.exe"
$runArgs = "/k `"$InstallDir\tokenops.cmd`" agent run"
New-Shortcut (Join-Path $StartMenuDir "TokenOps Agent.lnk") $cmdExe $runArgs $InstallDir "Start TokenOps agent"
New-Shortcut (Join-Path $StartMenuDir "TokenOps Status.lnk") $cmdExe "/k `"$InstallDir\tokenops.cmd`" status" $InstallDir "Show agent status"
New-Shortcut (Join-Path $StartMenuDir "TokenOps Config Folder.lnk") "explorer.exe" $ConfigDir $ConfigDir "Open config folder"
New-Shortcut (Join-Path $Desktop "TokenOps Agent.lnk") $cmdExe $runArgs $InstallDir "Start TokenOps agent"
Write-Ok "Shortcuts created"

# --- Startup task ---
$taskName = "TokenOpsAgent"
if ($wantStartup) {
  Write-Step "Registering logon startup task ($taskName)…"
  $action = New-ScheduledTaskAction -Execute $cmdExe -Argument "/c `"$InstallDir\tokenops.cmd`" agent run" -WorkingDirectory $InstallDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-Ok "Agent will start when you sign in to Windows"
  } catch {
    Write-Warn "Could not create scheduled task: $($_.Exception.Message)"
    $wantStartup = $false
  }
} else {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Ok "No auto-start (start manually: tokenops agent run)"
}

# --- Manifest for uninstall ---
$manifest = @{
  installedAt = (Get-Date).ToString("o")
  installDir = $InstallDir
  envVars = $envVarsSet
  startupTask = $wantStartup
  tools = @{
    claudeCode = $useClaude
    cursor = $useCursor
    grok = $useGrok
    openai = $useOpenAI
    otherOpenaiCompatible = $useOtherOai
  }
  cloudUrl = $cloudUrl
  upstream = $upstream
}
New-Item -ItemType Directory -Path (Split-Path $ManifestPath) -Force | Out-Null
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $ManifestPath -Encoding UTF8

Write-Host ""
Write-Host "  Install complete." -ForegroundColor Green
Write-Host ""
Write-Host "  Summary" -ForegroundColor White
Write-Host "  -------"
Write-Host "  Tools: Claude=$useClaude  Cursor=$useCursor  Grok=$useGrok  OpenAI=$useOpenAI  Other=$useOtherOai"
Write-Host "  Proxy: $ProxyListen → $upstream  (enabled=$openaiProxy)"
Write-Host "  Claude OTEL: $(if ($useClaude) { $OtelEndpoint } else { 'off' })"
Write-Host "  Cloud: $cloudUrl"
Write-Host "  PAT:   $(if ($ingestToken) { 'set' } else { 'NOT SET — add in config or re-run installer' })"
Write-Host "  Startup on sign-in: $wantStartup"
Write-Host "  Config: $configPath"
Write-Host ""
if (-not $ingestToken) {
  Write-Host "  Next: open $DashboardUrl → Settings → Create token" -ForegroundColor Yellow
  Write-Host "        paste into config as cloud.ingest_token" -ForegroundColor Yellow
  Write-Host ""
}
Write-Host "  Start now:  tokenops agent run"
Write-Host "  Status:     tokenops status"
Write-Host "  Uninstall:  uninstall.cmd"
Write-Host ""
Write-Host "  Note: new env vars apply to NEW terminals (and after sign-out/in for some apps)." -ForegroundColor DarkGray
Write-Host ""
