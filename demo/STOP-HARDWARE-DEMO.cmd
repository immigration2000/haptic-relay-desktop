@echo off
chcp 65001 >nul
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\stop-hardware-demo.ps1"
set "RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RESULT%
