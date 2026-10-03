@echo off
title Channel Planner
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "process.exit(Number(process.versions.node.split('.')[0]) < 22 ? 1 : 0)"
if errorlevel 1 goto nonode

echo.
echo  Getting Channel Planner ready. The first time takes a few minutes...
echo.
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 goto failed
call npm run build --silent
if errorlevel 1 goto failed

rem Open the browser once the app has had a few seconds to start.
start "" /min cmd /c "timeout /t 5 /nobreak >nul & start http://localhost:3000"
call npm start --silent
goto end

:nonode
echo.
echo  Channel Planner needs Node.js version 22 or newer.
echo  Your browser will now open the download page.
echo  Download the "LTS" version, install it, then double-click this file again.
echo.
start "" https://nodejs.org/en/download
pause
goto end

:failed
echo.
echo  Something went wrong while getting ready. Check your internet connection and try again.
echo  If it keeps happening, take a screenshot of this window and ask for help.
echo.
pause

:end
