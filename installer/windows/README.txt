TokenOps Desktop Agent — Windows installer
==========================================

REQUIREMENTS
  - Windows 10/11
  - Node.js 22 or newer (https://nodejs.org/)
  - Internet access for first-time cloud sync

INSTALL (on this PC)
  1. Double-click install.cmd
     (uses PowerShell Bypass so execution-policy does not block it)
  2. Follow the on-screen next steps (PAT + config)
  3. Start Menu → "TokenOps Agent"  or  run:  tokenops agent run

  Optional:  install.cmd -NoStartup
    Install without a logon scheduled task.

UNINSTALL
  Double-click uninstall.cmd
  (keeps %USERPROFILE%\.tokenops config unless you delete it)

WHAT GETS INSTALLED
  %LOCALAPPDATA%\TokenOps\agent     agent files
  %LOCALAPPDATA%\TokenOps\bin       tokenops.cmd on user PATH
  %USERPROFILE%\.tokenops           config, identity, outbox DB
  Start Menu + Desktop shortcuts
  Task Scheduler: TokenOpsAgent (at logon)

CLOUD
  Dashboard:  https://tokenops-web-production.up.railway.app
  API:        https://tokenops-api-production.up.railway.app

CLAUDE CODE TELEMETRY (while agent is running)
  set CLAUDE_CODE_ENABLE_TELEMETRY=1
  set OTEL_METRICS_EXPORTER=otlp
  set OTEL_EXPORTER_OTLP_PROTOCOL=http/json
  set OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
  claude

BUILD THIS PACKAGE (developers)
  From repo root:
    pnpm.cmd install
    node scripts/package-agent.mjs
  Output: dist/tokenops-agent-win/
