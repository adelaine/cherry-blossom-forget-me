@echo off
setlocal
set "bootstrap_dir=%~dp0"
set "no_pause="
:arguments
if "%~1"=="" goto launch
if /i "%~1"=="--json" set "no_pause=1"
if /i "%~1"=="--non-interactive" set "no_pause=1"
shift
goto arguments
:launch
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%bootstrap_dir%start-suitecloud.ps1" %*
set "launch_status=%errorlevel%"
if not "%launch_status%"=="0" if not "%launch_status%"=="10" if not defined no_pause pause
exit /b %launch_status%
