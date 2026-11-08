<#
.SYNOPSIS
  Nainštaluje aplikáciu „AdNa Sestra“ na počítač sestry (Windows 10/11).

.DESCRIPTION
  Vytvorí odkaz na ploche a v ponuke Štart (voliteľne aj v Po spustení), ktorý otvorí rozhranie
  sestry v samostatnom okne Microsoft Edge (režim aplikácie: bez panela s adresou a kariet)
  s vlastným profilom. Nič nesťahuje z internetu a nemení systémové nastavenia.

.PARAMETER ServerUrl
  Adresa servera AdNa v sieti ambulancie, napr. http://192.168.1.10:8080

.PARAMETER Autostart
  Spúšťať aplikáciu automaticky po prihlásení do Windows.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\Instalovat-AdNa-Sestra.ps1 -ServerUrl http://192.168.1.10:8080 -Autostart
#>
param(
  [string]$ServerUrl,
  [switch]$Autostart
)
$ErrorActionPreference = 'Stop'

if (-not $ServerUrl) {
  $ServerUrl = Read-Host 'Zadajte adresu servera AdNa (napr. https://vyvolavaci.adna.sk alebo http://192.168.1.10:8080)'
}
$ServerUrl = $ServerUrl.Trim().TrimEnd('/')
if ($ServerUrl -notmatch '^https?://') { $ServerUrl = 'http://' + $ServerUrl }
$AppUrl = "$ServerUrl/sestra/"

# 1. Overenie, že server odpovedá
Write-Host "Overujem server $ServerUrl ..."
try {
  $h = Invoke-RestMethod -Uri "$ServerUrl/api/health" -TimeoutSec 5
  if (-not $h.ok) { throw 'neplatná odpoveď' }
  Write-Host "Server odpovedá (deň $($h.day))." -ForegroundColor Green
} catch {
  Write-Warning "Server $ServerUrl neodpovedá: $($_.Exception.Message)"
  $c = Read-Host 'Pokračovať aj tak? (a/n)'
  if ($c -ne 'a') { exit 1 }
}

# 2. Nájdenie Microsoft Edge
$edgeCandidates = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
$edge = $edgeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $edge) { Write-Error 'Microsoft Edge sa nenašiel. Nainštalujte ho a spustite skript znova.'; exit 1 }

# 3. Vlastný profil aplikácie (oddelené cookies = prihlásenie len pre túto aplikáciu)
$profileDir = Join-Path $env:LOCALAPPDATA 'AdNa\Sestra\EdgeProfil'
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
$configFile = Join-Path $env:LOCALAPPDATA 'AdNa\Sestra\server.txt'
Set-Content -Path $configFile -Value $ServerUrl -Encoding UTF8

$arguments = "--app=`"$AppUrl`" --user-data-dir=`"$profileDir`" --no-first-run --disable-features=Translate --autoplay-policy=no-user-gesture-required"

# 4. Odkazy
$shell = New-Object -ComObject WScript.Shell
function New-AdNaShortcut([string]$path) {
  $s = $shell.CreateShortcut($path)
  $s.TargetPath = $edge
  $s.Arguments = $arguments
  $s.WorkingDirectory = Split-Path $edge
  $s.IconLocation = "$edge,0"
  $s.Description = 'AdNa – vyvolávací systém (sestra)'
  $s.Save()
  Write-Host "Vytvorený odkaz: $path"
}
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'AdNa'
New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
New-AdNaShortcut (Join-Path $desktop 'AdNa Sestra.lnk')
New-AdNaShortcut (Join-Path $startMenu 'AdNa Sestra.lnk')
if ($Autostart) {
  New-AdNaShortcut (Join-Path ([Environment]::GetFolderPath('Startup')) 'AdNa Sestra.lnk')
}

Write-Host ''
Write-Host 'Hotovo. Aplikáciu spustíte odkazom „AdNa Sestra“ na ploche.' -ForegroundColor Green
$run = Read-Host 'Spustiť aplikáciu teraz? (a/n)'
if ($run -eq 'a') { Start-Process -FilePath $edge -ArgumentList $arguments }
