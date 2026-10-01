@echo off
setlocal
call "%~dp0setup\start-suitecloud.cmd"
exit /b %errorlevel%
