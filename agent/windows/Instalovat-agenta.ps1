# Nainštaluje lokálneho agenta AdNa pre VRP2 na počítači recepcie a zaregistruje ho, aby sa spúšťal sám
# po prihlásení používateľa do Windows (agent potrebuje používateľskú reláciu – tlačiareň a profil prehliadača).
# Spustite v PowerShell ako ten používateľ Windows, pod ktorým recepcia beží:  .\Instalovat-agenta.ps1
# Ostrý režim (VRP2 Finančnej správy) sa týmto NEZAPÍNA – agent začína v simulátore.
param(
  [string]$NodePath = (Get-Command node -ErrorAction Stop).Source,
  [string]$ConfigDir = (Join-Path $env:ProgramData "AdNa\vrp2-agent"),
  [switch]$SProhliadacom   # nainštaluje aj Chromium pre Playwright (treba až pre ostrý režim)
)
$ErrorActionPreference = "Stop"
$agentDir = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
# konfigurácia obsahuje token agenta – prístup len pre tohto používateľa a správcov
icacls $ConfigDir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null
$cfg = Join-Path $ConfigDir "konfiguracia.json"
if (-not (Test-Path $cfg)) {
  Copy-Item (Join-Path $agentDir "konfiguracia.vzor.json") $cfg
  Write-Host "Vytvorená konfigurácia: $cfg  – doplňte adresu servera, token agenta a tlačiareň."
}
$ovl = Join-Path $ConfigDir "vrp2-ovladanie.json"
if (-not (Test-Path $ovl)) { Copy-Item (Join-Path $agentDir "vrp2-ovladanie.vzor.json") $ovl }
if ($SProhliadacom) {
  Push-Location $agentDir
  npm install --no-save playwright
  npx playwright install chromium
  Pop-Location
}
$action = New-ScheduledTaskAction -Execute $NodePath -Argument "src\index.js spustit --konfiguracia `"$cfg`"" -WorkingDirectory $agentDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "AdNa VRP2 agent" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Agent je zaregistrovaný (úloha „AdNa VRP2 agent“, spustí sa po prihlásení do Windows)."
Write-Host "Ďalej: 1) vyplňte $cfg   2) node src\index.js kontrola --konfiguracia `"$cfg`"   3) Start-ScheduledTask -TaskName 'AdNa VRP2 agent'"
