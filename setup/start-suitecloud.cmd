@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-suitecloud.ps1"
set "launch_status=%errorlevel%"
if errorlevel 1 pause
exit /b %launch_status%
