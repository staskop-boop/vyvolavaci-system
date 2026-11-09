# Inštalácia servera AdNa na Windows server / PC v ambulancii (Windows 10/11, Windows Server 2019+).
# Spustite v PowerShell AKO SPRÁVCA:
#   powershell -ExecutionPolicy Bypass -File Instalovat-server.ps1
# alebo priamo z GitHubu (PowerShell ako správca):
#   irm https://raw.githubusercontent.com/staskop-boop/vyvolavaci-system/main/deploy/windows/Instalovat-server.ps1 -OutFile $env:TEMP\adna.ps1
#   powershell -ExecutionPolicy Bypass -File $env:TEMP\adna.ps1
#
# Čo urobí: Node.js 22, kód z GitHubu do C:\AdNa\app, údaje v C:\AdNa\data, server ako úloha pri štarte
# (aj bez prihlásenia, reštart pri páde), automatická aktualizácia z GitHubu (každých 15 min), denná záloha,
# firewall pre LAN (port 8080) a Cloudflare Tunnel (cloudflared) pre https://vyvolavaci.adna.sk.
# Opakované spustenie je bezpečné (údaje sa nemažú).
param(
  [string]$TunelToken = "",
  [string]$Koren = "C:\AdNa",
  [string]$Vetva = "main",     # vetva/commit z GitHubu (test v CI používa vetvu PR)
  [switch]$BezTunela           # bez otázky na token (len LAN, napr. test)
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host "⚠ Spustite PowerShell ako správca (pravým tlačidlom → Spustiť ako správca)." -ForegroundColor Red; return }

$Repo = "staskop-boop/vyvolavaci-system"
$Data = Join-Path $Koren "data"
$Tmp  = Join-Path $env:TEMP "adna-instalacia"
New-Item -ItemType Directory -Force -Path $Koren, $Data, $Tmp | Out-Null

function Krok($t) { Write-Host "`n== $t ==" -ForegroundColor Cyan }

Krok "1/6 Node.js 22"
$node = "$env:ProgramFiles\nodejs\node.exe"
$ver = if (Test-Path $node) { (& $node -v) } else { "" }
if ($ver -notmatch '^v(2[2-9]|[3-9]\d)\.') {
  $rel = (Invoke-RestMethod "https://nodejs.org/dist/index.json") | Where-Object { $_.version -like "v22.*" -and $_.lts } | Select-Object -First 1
  $msi = Join-Path $Tmp "node.msi"
  Invoke-WebRequest "https://nodejs.org/dist/$($rel.version)/node-$($rel.version)-x64.msi" -OutFile $msi
  Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
  Write-Host "Nainštalovaný Node.js $($rel.version)"
} else { Write-Host "Node.js $ver už je nainštalovaný" }
if (-not (Test-Path $node)) { throw "Node.js sa nepodarilo nainštalovať." }

Krok "2/6 Kód z GitHubu"
$skript = Join-Path $Koren "aktualizuj.ps1"
Invoke-WebRequest "https://raw.githubusercontent.com/$Repo/$Vetva/deploy/windows/aktualizuj.ps1" -OutFile $skript
& powershell -NoProfile -ExecutionPolicy Bypass -File $skript -Koren $Koren -Vetva $Vetva -Vynutit -BezSpustenia
if (-not (Test-Path (Join-Path $Koren "app\server\src\index.js"))) { throw "Kód sa nepodarilo stiahnuť." }

Krok "3/6 Server ako úloha pri štarte"
$spustit = Join-Path $Koren "spustit-server.cmd"
@"
@echo off
rem Spúšťa úloha „AdNa server“. Údaje sú mimo kódu, aby ich aktualizácia neprepísala.
set ADNA_DATA_DIR=$Data
cd /d "$Koren\app\server"
"$node" --disable-warning=ExperimentalWarning src\index.js
"@ | Set-Content -Path $spustit -Encoding ASCII
$sys = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$nast = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "AdNa server" -Force -Principal $sys -Settings $nast `
  -Action (New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$spustit`"") `
  -Trigger (New-ScheduledTaskTrigger -AtStartup) | Out-Null
Stop-ScheduledTask -TaskName "AdNa server" -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName "AdNa server"

Krok "4/6 Aktualizácia (každých 15 min) a záloha (denne 22:30)"
$opak = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName "AdNa aktualizácia" -Force -Principal $sys `
  -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -StartWhenAvailable) `
  -Action (New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$skript`" -Koren `"$Koren`" -Vetva $Vetva") `
  -Trigger $opak | Out-Null
$zaloha = Join-Path $Koren "zaloha.cmd"
@"
@echo off
set ADNA_DATA_DIR=$Data
cd /d "$Koren\app\server"
"$node" --disable-warning=ExperimentalWarning scripts\zaloha.js
"@ | Set-Content -Path $zaloha -Encoding ASCII
Register-ScheduledTask -TaskName "AdNa záloha" -Force -Principal $sys `
  -Action (New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$zaloha`"") `
  -Trigger (New-ScheduledTaskTrigger -Daily -At "22:30") | Out-Null

Krok "5/6 Firewall (port 8080 len pre súkromnú/doménovú sieť)"
if (-not (Get-NetFirewallRule -DisplayName "AdNa server 8080" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "AdNa server 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Profile Private,Domain -Action Allow | Out-Null
}

Krok "6/6 Cloudflare Tunnel (https://vyvolavaci.adna.sk)"
$cfd = @("${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:ProgramFiles\cloudflared\cloudflared.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($BezTunela) { Write-Host "Tunel preskočený (-BezTunela)." }
elseif (-not (Get-Service cloudflared -ErrorAction SilentlyContinue)) {
  if (-not $TunelToken) {
    Write-Host "Token tunela: Cloudflare → Zero Trust → Networks → Tunnels → vyvolavaci → Configure (dlhý reťazec za 'service install')."
    $TunelToken = Read-Host "Vložte token (alebo Enter = preskočiť, systém pobeží len v LAN)"
  }
  if ($TunelToken) {
    if (-not $cfd) {
      $m = Join-Path $Tmp "cloudflared.msi"
      Invoke-WebRequest "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.msi" -OutFile $m
      Start-Process msiexec.exe -ArgumentList "/i `"$m`" /qn /norestart" -Wait
      $cfd = @("${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:ProgramFiles\cloudflared\cloudflared.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
    }
    & $cfd service install $TunelToken.Trim()
    Write-Host "cloudflared nainštalovaný ako služba Windows."
  } else { Write-Host "Tunel preskočený – doinštalujete spustením skriptu znova." -ForegroundColor Yellow }
} else { Write-Host "Služba cloudflared už beží." }

Start-Sleep 5
$ok = $false; for ($i = 0; $i -lt 20; $i++) { try { Invoke-RestMethod "http://localhost:8080/api/health" | Out-Null; $ok = $true; break } catch { Start-Sleep 2 } }
Write-Host ""
if ($ok) { Write-Host "✔ Server beží: http://localhost:8080/sestra/" -ForegroundColor Green } else { Write-Host "⚠ Server zatiaľ neodpovedá – pozrite $Data\logs\server.log" -ForegroundColor Red }
$kod = Join-Path $Data "SETUP-KOD.txt"
if (Test-Path $kod) { Write-Host "INŠTALAČNÝ KÓD pre prvé prihlásenie do aplikácie Sestra: $(Get-Content $kod)" -ForegroundColor Yellow }
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | Select-Object -First 1).IPAddress
Write-Host "V LAN: http://${ip}:8080/sestra/   Z internetu: https://vyvolavaci.adna.sk/sestra/"
