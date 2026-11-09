# AdNa – spustenie obrazovky v čakárni na mini PC (Windows 10/11) pripojenom cez HDMI k televízoru Samsung.
# Použitie: v Plánovači úloh spúšťať pri prihlásení používateľa (pozri README.md).
#   Rezim "ramec" (odporúčaný): jedno okno na celú obrazovku, prehrávač Antik TV je vložený v TV zóne.
#   Rezim "okna"  (záloha):     stránka AdNa na celú obrazovku + samostatné okno prehrávača presne nad TV zónou.
param(
  [switch]$Nastavenie,
  [string]$Server = "https://vyvolavaci.adna.sk",
  [string]$Prehravac = "https://webtv.sk/",
  [ValidateSet("ramec", "okna")] [string]$Rezim = "ramec",
  # v3.1: Microsoft Edge má slovenské hlasy pre hlásenie čísla (Viktória/Lukáš Online, offline Filip); Chrome ich na Windows spravidla nevidí
  [ValidateSet("edge", "chrome")] [string]$Prehliadac = "edge",
  # Obraz TV pri 1920×1080, dizajn v3 (vypíše ho stránka: v konzole prehliadača window.AdNaLayout.tv)
  [int]$TvX = 642, [int]$TvY = 178, [int]$TvW = 1228, [int]$TvH = 698
)
$ErrorActionPreference = "Stop"
if ($Prehliadac -eq "edge") {
  $chrome = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  $rozsirenia = "edge://extensions"
} else {
  $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  $rozsirenia = "chrome://extensions"
}
if (-not $chrome) { throw "Nenašiel sa prehliadač $Prehliadac. Nainštalujte ho a skript spustite znova." }
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$profil = Join-Path $env:LOCALAPPDATA "AdNa\obrazovka-profil"     # tu ostáva prihlásenie do Antik TV
New-Item -ItemType Directory -Force -Path $profil | Out-Null

# počkáme na sieť a server (po zapnutí PC)
for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "$Server/api/health" | Out-Null; break } catch { Start-Sleep 5 } }

$spolocne = @("--user-data-dir=$profil", "--no-first-run", "--disable-session-crashed-bubble", "--disable-infobars",
              "--autoplay-policy=no-user-gesture-required", "--disable-features=Translate", "--noerrdialogs")

if ($Rezim -eq "ramec") {
  # TV zónu vyplní vložený prehrávač; adresu prehrávača nastavte v aplikácii Sestra → Nastavenia → Obrazovka
  # rozšírenie rozsirenie-tv-ramec musí byť raz nainštalované v tomto profile (README, krok 3) – nový Chrome už neprijíma --load-extension
  if ($Nastavenie) { Start-Process $chrome -ArgumentList ($spolocne + @($rozsirenia, "$Server/obrazovka/?hlas=test")); return }
  Start-Process $chrome -ArgumentList ($spolocne + @("--kiosk", "$Server/obrazovka/"))
} else {
  # súradnice platia pre 1920×1080; pri inom rozlíšení alebo zväčšení (125 %, 150 %) ich prepočítame podľa šírky obrazovky
  if (-not ($PSBoundParameters.ContainsKey("TvX") -or $PSBoundParameters.ContainsKey("TvW"))) {
    Add-Type -AssemblyName System.Windows.Forms
    $obr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $k = $obr.Width / 1920.0
    if ([math]::Abs($k - 1) -gt 0.01) {
      $TvX = [int]($TvX * $k); $TvY = [int]($TvY * $k); $TvW = [int]($TvW * $k); $TvH = [int]($TvH * $k)
    }
  }
  Start-Process $chrome -ArgumentList ($spolocne + @("--kiosk", "$Server/obrazovka/?zona=prazdna"))
  Start-Sleep 6
  $profil2 = Join-Path $env:LOCALAPPDATA "AdNa\prehravac-profil"
  New-Item -ItemType Directory -Force -Path $profil2 | Out-Null
  Start-Process $chrome -ArgumentList @("--user-data-dir=$profil2", "--no-first-run", "--autoplay-policy=no-user-gesture-required",
    "--app=$Prehravac", "--window-position=$TvX,$TvY", "--window-size=$TvW,$TvH")
}
