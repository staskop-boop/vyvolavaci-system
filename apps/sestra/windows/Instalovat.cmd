@echo off
rem Spustenie instalacie AdNa Sestra (dvojklik)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Instalovat-AdNa-Sestra.ps1" %*
pause
