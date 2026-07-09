@echo off
rem DramaClaw portable - stop script (kills only processes from this package)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_stop.ps1"
pause
