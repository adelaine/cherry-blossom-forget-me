@echo off
setlocal
call "%~dp0setup\bootstrap\start-suitecloud.cmd"
exit /b %errorlevel%
