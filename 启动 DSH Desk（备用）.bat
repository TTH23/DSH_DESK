@echo off
rem DSH Desk launcher. ASCII only, CRLF line endings.
cd /d "%~dp0" >nul 2>&1
if errorlevel 1 goto :fail
if not exist "node_modules\electron\dist\electron.exe" goto :fail
start "" "node_modules\electron\dist\electron.exe" "."
exit /b 0

:fail
echo [DSH Desk] Failed to start.
echo   - Working dir: %CD%
echo   - electron.exe missing or %~dp0 unreachable. Run: npm install
pause
exit /b 1
