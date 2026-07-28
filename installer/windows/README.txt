TokenOps Desktop Agent — Windows installer
==========================================

REQUIREMENTS
  - Windows 10/11
  - Node.js 22 or newer (https://nodejs.org/)

RECOMMENDED: TokenOps-Agent-Setup.exe
  Download from GitHub Releases, double-click, complete the wizard.
  Per-user install (no admin). Uninstall from Windows Settings → Apps.

PORTABLE / ZIP (install.cmd)
  1. Double-click install.cmd
  2. Answer the prompts:
       - Which AI tools you use (Claude Code, Cursor, Grok/xAI, OpenAI, …)
       - TokenOps API URL + ingest PAT
       - Optional API keys (stored as user environment variables)
       - Whether the agent should start when Windows signs you in
  3. Start Menu → "TokenOps Agent"  or  tokenops agent run

  Quiet / CI (no questions):
    install.cmd -Quiet
    install.cmd -Quiet -NoStartup

WHAT THE WIZARD CONFIGURES
  Claude Code
    User env: CLAUDE_CODE_ENABLE_TELEMETRY, OTEL_* → http://127.0.0.1:4318
    config: claude_code=true, claude_code_otel_listen
    Desktop: "Claude Code + TokenOps.cmd"

  Cursor / OpenAI-compatible
    User env: OPENAI_BASE_URL, OPENAI_API_BASE → http://127.0.0.1:8787/v1
    config: openai_proxy=true
    (Cursor Settings may still need the same base URL manually)

  Grok / xAI
    upstream https://api.x.ai/v1 when Grok is the only proxy tool
    User env: XAI_API_KEY (if you paste it)

  OpenAI
    upstream https://api.openai.com
    User env: OPENAI_API_KEY (if you paste it)

  Startup
    Task Scheduler job "TokenOpsAgent" at logon (if you said yes)

UNINSTALL
  Double-click uninstall.cmd
  Removes agent files, PATH entry, OTEL/base-url env vars from the install
  manifest. Keeps API keys and %USERPROFILE%\.tokenops unless you delete them.

BUILD PACKAGE (developers)
  pnpm.cmd package:agent
  Output: dist\tokenops-agent-win\
