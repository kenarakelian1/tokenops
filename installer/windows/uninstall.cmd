@echo off
setlocal
title TokenOps Agent Uninstaller
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
set ERR=%ERRORLEVEL%
if %ERR% neq 0 (
  echo Uninstall failed with exit code %ERR%.
  pause
  exit /b %ERR%
)
echo.
pause
exit /b 0
