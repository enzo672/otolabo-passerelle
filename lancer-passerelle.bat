@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js nest pas installe : https://nodejs.org (version LTS^) & pause & exit /b 1)
if not exist node_modules call npm install --no-audit --no-fund
call npm run gateway
pause
