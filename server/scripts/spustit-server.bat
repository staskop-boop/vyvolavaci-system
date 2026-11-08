@echo off
REM Spustenie servera AdNa na Windows (okno musí ostať otvorené). Pre trvalú prevádzku pozri docs/INSTALACIA.md.
cd /d "%~dp0.."
if not exist node_modules (
  echo Instalujem zavislosti...
  call npm ci --omit=dev
)
node --disable-warning=ExperimentalWarning src\index.js
pause
