# Zaregistruje server AdNa ako naplánovanú úlohu, ktorá sa spustí pri štarte počítača (aj bez prihlásenia)
# a pri páde sa automaticky reštartuje. Spustite v PowerShell ako správca.
param([string]$NodePath = (Get-Command node -ErrorAction Stop).Source)
$serverDir = Split-Path -Parent $PSScriptRoot
$action = New-ScheduledTaskAction -Execute $NodePath -Argument "--disable-warning=ExperimentalWarning src\index.js" -WorkingDirectory $serverDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName "AdNa server" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
New-NetFirewallRule -DisplayName "AdNa server 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Profile Private,Domain -Action Allow -ErrorAction SilentlyContinue | Out-Null
Start-ScheduledTask -TaskName "AdNa server"
Write-Host "Server AdNa je zaregistrovaný a spustený. Overte: http://localhost:8080/api/health"
