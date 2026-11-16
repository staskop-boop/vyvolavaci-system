#!/usr/bin/env bash
# AdNa – obrazovka v čakárni na mini PC s Linuxom (Ubuntu, Mint, Debian…), pripojenom cez HDMI k TV.
# Rovnaké správanie ako spustit-obrazovku.ps1 na Windows: jedno okno na celú obrazovku, Antik TV vložený
# v TV zóne s doplnkom rozsirenie-tv-ramec (bez neho Antik hlási „Zadali ste nesprávne údaje“).
# Všetko ostatné (Sestra, štatistiky, nastavenia) beží na https://vyvolavaci.adna.sk – na mini PC netreba server.
#
# Prvé nastavenie (v termináli, raz):
#   curl -fsSL https://raw.githubusercontent.com/staskop-boop/vyvolavaci-system/main/apps/tv/minipc/obrazovka-linux.sh | bash -s -- --instalovat
# Potom ikona „AdNa obrazovka“ na ploche alebo:
#   ~/AdNa-obrazovka/obrazovka-linux.sh               spustí obrazovku na celú obrazovku (Alt+F4 ju zavrie)
#   ~/AdNa-obrazovka/obrazovka-linux.sh --nastavenie  obrazovka v okne + stránka doplnkov (prihlásenie do Antiku)
#   ~/AdNa-obrazovka/obrazovka-linux.sh --autostart   obrazovka sa spustí sama po prihlásení, obraz sa nevypína
# Ak doplnok v profile chýba, spúšťač sám otvorí nastavenie s návodom namiesto obrazovky.
set -uo pipefail

SERVER="${ADNA_SERVER:-https://vyvolavaci.adna.sk}"
ZDROJ="${ADNA_ZDROJ:-https://raw.githubusercontent.com/staskop-boop/vyvolavaci-system/main/apps/tv/minipc}"
# Priečinok bez bodky na začiatku – prehliadač nainštalovaný ako snap (Ubuntu) nevidí skryté priečinky.
DIR="$HOME/AdNa-obrazovka"
PROFIL="$DIR/profil"           # tu ostáva prihlásenie do Antik TV a nainštalovaný doplnok
ROZ="$DIR/rozsirenie-tv-ramec"
AKCIA="spustit"; BEZ_AKT=""
for a in "$@"; do
  case "$a" in
    --instalovat) AKCIA=instalovat ;;
    --nastavenie) AKCIA=nastavenie ;;
    --autostart) AKCIA=autostart ;;
    --bez-aktualizacie) BEZ_AKT=1 ;;
    *) echo "⚠ Neznámy prepínač: $a"; exit 2 ;;
  esac
done

chyba() { echo "⚠ $*" >&2; command -v notify-send >/dev/null && notify-send "AdNa obrazovka" "⚠ $*" 2>/dev/null; exit 1; }
stiahni() { # stiahne súbor zo ZDROJ do cieľa; pri chybe ponechá pôvodný
  local f="$1" ciel="$DIR/$1"
  mkdir -p "$(dirname "$ciel")"
  if curl -fsSL -m 20 "$ZDROJ/$f" -o "$ciel.novy" && [ -s "$ciel.novy" ]; then mv -f "$ciel.novy" "$ciel"; else rm -f "$ciel.novy"; return 1; fi
}
aktualizuj() {
  # Online aktualizácia z GitHubu (repo je verejné). Prehliadač rozbalený doplnok pri štarte načíta z priečinka znova.
  local zoznam f
  zoznam=$(curl -fsSL -m 15 "$ZDROJ/subory.txt") || { echo "⚠ Aktualizácia sa nepodarila (bez internetu?), spúšťam doterajšiu verziu."; return 0; }
  while IFS= read -r f; do
    f="${f%$'\r'}"
    case "$f" in ''|'#'*|*..*) continue ;; rozsirenie-tv-ramec/*|obrazovka-linux.sh) stiahni "$f" || echo "⚠ Nepodarilo sa stiahnuť $f" ;; esac
  done <<<"$zoznam"
  chmod +x "$DIR/obrazovka-linux.sh" 2>/dev/null || true
}
najdi_prehliadac() {
  # Edge má slovenský ženský hlas (Viktória) aj prehrávanie chránených videí; Chrome a Chromium sú záloha.
  for p in microsoft-edge microsoft-edge-stable google-chrome google-chrome-stable chromium chromium-browser; do
    command -v "$p" >/dev/null 2>&1 && { echo "$p"; return 0; }
  done
  return 1
}
doplnok_nainstalovany() { # prehliadač si v profile pamätá cestu k rozbalenému doplnku
  grep -qs -- "$ROZ\"" "$PROFIL/Default/Preferences" "$PROFIL/Default/Secure Preferences"
}
vytvor_ikony() {
  local app="$HOME/.local/share/applications" plocha
  mkdir -p "$app"
  cat > "$app/adna-obrazovka.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=AdNa obrazovka
Comment=Obrazovka čakárne AdNa na celú obrazovku (Alt+F4 ju zavrie)
Exec=$DIR/obrazovka-linux.sh
Icon=video-display
Terminal=false
Categories=Utility;
EOF
  cat > "$app/adna-obrazovka-nastavenie.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=AdNa obrazovka – nastavenie
Comment=Obrazovka v okne a stránka doplnkov (prihlásenie do Antik TV)
Exec=$DIR/obrazovka-linux.sh --nastavenie
Icon=preferences-system
Terminal=false
Categories=Utility;
EOF
  plocha=$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")
  if [ -d "$plocha" ]; then
    cp -f "$app/adna-obrazovka.desktop" "$app/adna-obrazovka-nastavenie.desktop" "$plocha/"
    chmod +x "$plocha"/adna-obrazovka*.desktop
    for f in "$plocha"/adna-obrazovka*.desktop; do gio set "$f" metadata::trusted true 2>/dev/null || true; done
  fi
}
navod_html() { # návod pre nastavenie ako prvá karta (aj keď spúšťač nebeží v termináli)
  cat > "$DIR/navod.html" <<EOF
<!doctype html><html lang="sk"><meta charset="utf-8"><title>Nastavenie obrazovky AdNa</title>
<style>body{font:20px/1.5 system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 16px;color:#111}
h1{color:#c8102e}code{background:#f2f4f7;padding:2px 8px;border-radius:6px;font-size:18px;word-break:break-all}
li{margin:12px 0}.pozor{border-left:6px solid #c8102e;padding:8px 16px;background:#fff5f6}</style>
<h1>Nastavenie obrazovky AdNa (raz na tomto počítači)</h1>
<p class="pozor">⚠ Bez doplnku „AdNa – TV prehrávač“ sa Antik TV v obrazovke neprihlási (hlási „Zadali ste nesprávne údaje“).</p>
<ol>
<li>Prepnite na kartu <b>Rozšírenia / Extensions</b> a zapnite <b>Režim pre vývojárov</b> (vpravo hore alebo vľavo dole).</li>
<li>Kliknite <b>Načítať rozbalené</b> (Load unpacked) a vyberte priečinok<br><code>$ROZ</code><br>
(v okne výberu: Domov → AdNa-obrazovka → rozsirenie-tv-ramec → Vybrať). Ak tam doplnok už je, nič nerobte.</li>
<li>Prepnite na kartu s obrazovkou AdNa, stlačte <b>F5</b> a v TV zóne sa raz prihláste do Antik TV.</li>
<li>Zavrite toto okno a spustite ikonu <b>AdNa obrazovka</b> na ploche (alebo počítač reštartujte, ak je zapnutý automatický štart).</li>
</ol></html>
EOF
}

mkdir -p "$DIR" "$PROFIL"

case "$AKCIA" in
  instalovat)
    command -v curl >/dev/null || chyba "Chýba program curl. Nainštalujte ho príkazom: sudo apt install curl"
    aktualizuj
    [ -f "$ROZ/manifest.json" ] || chyba "Doplnok pre Antik sa nepodarilo stiahnuť. Skontrolujte internet a skúste znova."
    [ -x "$DIR/obrazovka-linux.sh" ] || chyba "Spúšťač sa nepodarilo stiahnuť. Skontrolujte internet a skúste znova."
    PREH=$(najdi_prehliadac) || chyba "Nenašiel sa prehliadač Microsoft Edge, Google Chrome ani Chromium. Odporúčame Microsoft Edge (má slovenský ženský hlas)."
    vytvor_ikony
    echo "Hotovo: súbory sú v $DIR, prehliadač: $PREH. Na ploche sú ikony „AdNa obrazovka“."
    echo "Teraz sa otvorí nastavenie – postupujte podľa návodu v prvej karte."
    exec "$DIR/obrazovka-linux.sh" --nastavenie --bez-aktualizacie
    ;;
  autostart)
    mkdir -p "$HOME/.config/autostart"
    cat > "$HOME/.config/autostart/adna-obrazovka.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=AdNa obrazovka
Exec=$DIR/obrazovka-linux.sh
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=10
EOF
    # bez šetriča, zamykania a vypínania obrazu (GNOME / Cinnamon / MATE / X11)
    gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null || true
    gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null || true
    gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing' 2>/dev/null || true
    gsettings set org.cinnamon.desktop.session idle-delay 0 2>/dev/null || true
    gsettings set org.cinnamon.desktop.screensaver lock-enabled false 2>/dev/null || true
    gsettings set org.cinnamon.settings-daemon.plugins.power sleep-display-ac 0 2>/dev/null || true
    gsettings set org.mate.screensaver idle-activation-enabled false 2>/dev/null || true
    if command -v xset >/dev/null; then xset s off -dpms 2>/dev/null || true; fi
    echo "Hotovo: obrazovka AdNa sa spustí sama po prihlásení. Obraz sa nebude vypínať."
    echo "Ešte zapnite automatické prihlásenie používateľa (Nastavenia → Používatelia → Automatické prihlásenie)."
    echo "Vypnutie: rm ~/.config/autostart/adna-obrazovka.desktop"
    exit 0
    ;;
esac

PREH=$(najdi_prehliadac) || chyba "Nenašiel sa prehliadač Microsoft Edge, Google Chrome ani Chromium."
[ -n "$BEZ_AKT" ] || aktualizuj
[ -f "$ROZ/manifest.json" ] || chyba "Chýba doplnok $ROZ – spustite znova s --instalovat."

# Spoločné nastavenia prehliadača. --load-extension doplnok načíta sám v Chromiu; Edge a Chrome (od verzie 137)
# ho ignorujú, preto sa tam doplnok raz načíta ručne a ostáva v profile (kontrola doplnok_nainstalovany).
SPOLOCNE=(--user-data-dir="$PROFIL" --no-first-run --no-default-browser-check --disable-session-crashed-bubble
  --disable-infobars --autoplay-policy=no-user-gesture-required --disable-features=Translate,DisableLoadExtensionCommandLineSwitch
  --noerrdialogs --password-store=basic --load-extension="$ROZ")
case "$PREH" in microsoft-edge*) STRANKA_DOPLNKOV="edge://extensions" ;; *) STRANKA_DOPLNKOV="chrome://extensions" ;; esac

# Ak sa prehliadač ešte nikdy nespustil, profil nepoznáme – krátko ho spustíme, nech skúsi doplnok načítať sám.
if [ "$AKCIA" = spustit ] && ! doplnok_nainstalovany && [ ! -f "$PROFIL/Default/Preferences" ]; then
  timeout 15 "$PREH" "${SPOLOCNE[@]}" --headless=new about:blank >/dev/null 2>&1 || true
fi
if [ "$AKCIA" = spustit ] && ! doplnok_nainstalovany; then
  echo "⚠ Doplnok pre Antik v profile obrazovky chýba – otváram nastavenie."
  AKCIA=nastavenie
fi

if [ "$AKCIA" = nastavenie ]; then
  navod_html
  echo "Nastavenie: postupujte podľa návodu v prvej karte prehliadača ($DIR/navod.html)."
  nohup "$PREH" "${SPOLOCNE[@]}" "file://$DIR/navod.html" "$STRANKA_DOPLNKOV" "$SERVER/obrazovka/?hlas=test" >/dev/null 2>&1 &
  exit 0
fi

# počkáme na sieť a server (po zapnutí PC), najviac 5 minút
for i in $(seq 1 60); do curl -fsS -m 3 "$SERVER/api/health" >/dev/null 2>&1 && break; sleep 5; done
# obraz sa nevypína, kým beží obrazovka
if command -v xset >/dev/null; then xset s off -dpms 2>/dev/null || true; fi
exec "$PREH" "${SPOLOCNE[@]}" --kiosk "$SERVER/obrazovka/" >/dev/null 2>&1
