@echo off
setlocal
title TokenOps Agent Installer
cd /d "%~dp0"

REM Always bypass PowerShell execution policy (pnpm.ps1 / install.ps1 issues)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set ERR=%ERRORLEVEL%
if %ERR% neq 0 (
  echo.
  echo Install failed with exit code %ERR%.
  pause
  exit /b %ERR%
)
echo.
pause
exit /b 0
