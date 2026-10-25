@echo off
setlocal
call "%~dp0..\app\container-setup\bootstrap\start-suitecloud.cmd" %*
exit /b %errorlevel%
