@echo off
setlocal
call "%~dp0..\app\setup\bootstrap\start-suitecloud.cmd" %*
exit /b %errorlevel%
