<#
.SYNOPSIS
  Odstráni aplikáciu „AdNa Sestra“ z tohto počítača (odkazy a lokálny profil prehliadača).
  Údaje na serveri sa NEMENIA.
#>
$ErrorActionPreference = 'SilentlyContinue'
$paths = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'AdNa Sestra.lnk'),
  (Join-Path (Join-Path ([Environment]::GetFolderPath('Programs')) 'AdNa') 'AdNa Sestra.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Startup')) 'AdNa Sestra.lnk')
)
foreach ($p in $paths) { if (Test-Path $p) { Remove-Item $p -Force; Write-Host "Odstránené: $p" } }
Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'AdNa') -Force -Recurse
$c = Read-Host 'Odstrániť aj lokálny profil aplikácie (prihlásenie, predvolená ambulancia)? (a/n)'
if ($c -eq 'a') { Remove-Item (Join-Path $env:LOCALAPPDATA 'AdNa\Sestra') -Force -Recurse; Write-Host 'Profil odstránený.' }
Write-Host 'Aplikácia AdNa Sestra bola odinštalovaná.' -ForegroundColor Green
