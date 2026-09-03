@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js non trovato. Installa Node.js 24.18.1 LTS e riprova.
  pause
  exit /b 1
)

for /f "tokens=1-3 delims=." %%A in ('node -p "process.versions.node"') do (
  set "NODE_MAJOR=%%A"
  set "NODE_MINOR=%%B"
  set "NODE_PATCH=%%C"
)

if not "%NODE_MAJOR%"=="24" goto node_version_error
if %NODE_MINOR% LSS 18 goto node_version_error
if %NODE_MINOR% EQU 18 if %NODE_PATCH% LSS 1 goto node_version_error

goto node_version_ok

:node_version_error
echo Versione Node.js non supportata: %NODE_MAJOR%.%NODE_MINOR%.%NODE_PATCH%
echo Installa Node.js 24.18.1 LTS o una versione successiva della linea 24.x.
pause
exit /b 1

:node_version_ok
set "NEEDS_INSTALL=0"
if not exist node_modules\express\package.json set "NEEDS_INSTALL=1"
if not exist node_modules\multer\package.json set "NEEDS_INSTALL=1"
if exist node_modules\music-metadata\package.json set "NEEDS_INSTALL=1"

if "%NEEDS_INSTALL%"=="1" (
  echo Installazione o aggiornamento dipendenze dal registry pubblico npm...
  call npm.cmd install --no-audit --no-fund --registry=https://registry.npmjs.org
  if errorlevel 1 (
    echo.
    echo Installazione non riuscita.
    echo Chiudi eventuali terminali o programmi aperti in questa cartella,
    echo elimina la cartella node_modules se presente e riprova.
    pause
    exit /b 1
  )
)

if not exist .env copy .env.example .env >nul
echo Avvio Baia Cinghiala...
call npm.cmd start
pause
