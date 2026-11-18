@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 20 or newer, then open this file again.
  pause
  exit /b 1
)
if not exist dist\server.js (
  call npm ci
  if errorlevel 1 goto failed
  call npm run build
  if errorlevel 1 goto failed
)
if not exist node_modules\ws\package.json (
  call npm ci --omit=dev
  if errorlevel 1 goto failed
)
echo LiveEdit server is starting. Keep this window open.
node dist/server.js
if errorlevel 1 goto failed
exit /b 0
:failed
echo Server did not start. Check the message above.
pause
exit /b 1
