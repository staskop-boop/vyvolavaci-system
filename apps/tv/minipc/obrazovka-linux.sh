#!/usr/bin/env bash
# AdNa – obrazovka v čakárni na mini PC s Linuxom (Ubuntu, Mint, Debian…), pripojenom cez HDMI k TV.
# Rovnaké správanie ako spustit-obrazovku.ps1 na Windows: jedno okno na celú obrazovku, Antik TV vložený
# v TV zóne s doplnkom rozsirenie-tv-ramec (bez neho Antik hlási „Zadali ste nesprávne údaje“).
#
# Prvé nastavenie (v termináli, raz):
#   curl -fsSL https://raw.githubusercontent.com/staskop-boop/vyvolavaci-system/main/apps/tv/minipc/obrazovka-linux.sh | bash -s -- --instalovat
# Potom:
#   ~/AdNa-obrazovka/obrazovka-linux.sh               spustí obrazovku na celú obrazovku
#   ~/AdNa-obrazovka/obrazovka-linux.sh --nastavenie  otvorí obrazovku v okne + stránku doplnkov (prihlásenie do Antiku)
#   ~/AdNa-obrazovka/obrazovka-linux.sh --autostart   obrazovka sa spustí sama po prihlásení, obraz sa nevypína
# Ukončenie obrazovky: Alt+F4.
set -uo pipefail

SERVER="${ADNA_SERVER:-https://vyvolavaci.adna.sk}"
ZDROJ="${ADNA_ZDROJ:-https://raw.githubusercontent.com/staskop-boop/vyvolavaci-system/main/apps/tv/minipc}"
# Priečinok bez bodky na začiatku – prehliadač nainštalovaný ako snap (Ubuntu) nevidí skryté priečinky.
DIR="$HOME/AdNa-obrazovka"
PROFIL="$DIR/profil"           # tu ostáva prihlásenie do Antik TV
ROZ="$DIR/rozsirenie-tv-ramec"
AKCIA="spustit"
for a in "$@"; do
  case "$a" in
    --instalovat) AKCIA=instalovat ;;
    --nastavenie) AKCIA=nastavenie ;;
    --autostart) AKCIA=autostart ;;
    --bez-aktualizacie) BEZ_AKT=1 ;;
    *) echo "⚠ Neznámy prepínač: $a"; exit 2 ;;
  esac
done

chyba() { echo "⚠ $*" >&2; exit 1; }
stiahni() { # stiahne súbor zo ZDROJ do cieľa; pri chybe ponechá pôvodný
  local f="$1" ciel="$DIR/$1"
  mkdir -p "$(dirname "$ciel")"
  if curl -fsSL -m 20 "$ZDROJ/$f" -o "$ciel.novy"; then mv -f "$ciel.novy" "$ciel"; else rm -f "$ciel.novy"; return 1; fi
}
aktualizuj() {
  local zoznam f
  zoznam=$(curl -fsSL -m 15 "$ZDROJ/subory.txt") || { echo "⚠ Aktualizácia sa nepodarila (bez internetu?), spúšťam doterajšiu verziu."; return 0; }
  stiahni obrazovka-linux.sh && chmod +x "$DIR/obrazovka-linux.sh"
  while IFS= read -r f; do
    f="${f%%$'\r'}"; f="${f## }"; f="${f%% }"
    case "$f" in ''|'#'*|*..*) continue ;; rozsirenie-tv-ramec/*) stiahni "$f" || echo "⚠ Nepodarilo sa stiahnuť $f" ;; esac
  done <<<"$zoznam"
}
najdi_prehliadac() {
  # Edge a Chrome majú prehrávanie chránených videí (Widevine) aj slovenské hlasy; Chromium je záloha.
  for p in microsoft-edge microsoft-edge-stable google-chrome google-chrome-stable chromium chromium-browser; do
    command -v "$p" >/dev/null 2>&1 && { echo "$p"; return 0; }
  done
  return 1
}

mkdir -p "$DIR" "$PROFIL"

case "$AKCIA" in
  instalovat)
    command -v curl >/dev/null || chyba "Chýba program curl: sudo apt install curl"
    aktualizuj
    [ -f "$ROZ/manifest.json" ] || chyba "Doplnok pre Antik sa nepodarilo stiahnuť. Skontrolujte internet a skúste znova."
    PREH=$(najdi_prehliadac) || chyba "Nenašiel sa prehliadač Microsoft Edge, Google Chrome ani Chromium. Nainštalujte jeden z nich a spustite znova."
    echo "Hotovo: súbory sú v $DIR, prehliadač: $PREH"
    echo "Teraz sa otvorí nastavenie (obrazovka v okne + stránka doplnkov)."
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
    # bez šetriča a vypínania obrazu (GNOME / Cinnamon / X11)
    gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null || true
    gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null || true
    gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing' 2>/dev/null || true
    gsettings set org.cinnamon.desktop.session idle-delay 0 2>/dev/null || true
    gsettings set org.cinnamon.settings-daemon.plugins.power sleep-display-ac 0 2>/dev/null || true
    command -v xset >/dev/null && { xset s off; xset -dpms; } 2>/dev/null || true
    echo "Hotovo: obrazovka AdNa sa spustí sama po prihlásení. Obraz sa nebude vypínať."
    echo "Ešte zapnite automatické prihlásenie používateľa (Nastavenia → Používatelia → Automatické prihlásenie)."
    echo "Vypnutie: rm ~/.config/autostart/adna-obrazovka.desktop"
    exit 0
    ;;
esac

PREH=$(najdi_prehliadac) || chyba "Nenašiel sa prehliadač Microsoft Edge, Google Chrome ani Chromium."
[ -n "${BEZ_AKT:-}" ] || aktualizuj
[ -f "$ROZ/manifest.json" ] || chyba "Chýba doplnok $ROZ – spustite znova s --instalovat."

# počkáme na sieť a server (po zapnutí PC), najviac 5 minút
if [ "$AKCIA" = spustit ]; then
  for i in $(seq 1 60); do curl -fsS -m 3 "$SERVER/api/health" >/dev/null 2>&1 && break; sleep 5; done
fi

SPOLOCNE=(--user-data-dir="$PROFIL" --no-first-run --disable-session-crashed-bubble --disable-infobars
  --autoplay-policy=no-user-gesture-required --disable-features=Translate --noerrdialogs
  --password-store=basic
  # Chromium doplnok načíta sám; Edge a Chrome tento prepínač ignorujú – tam sa doplnok načíta raz ručne (--nastavenie)
  --load-extension="$ROZ")

case "$PREH" in microsoft-edge*) STRANKA_DOPLNKOV="edge://extensions" ;; *) STRANKA_DOPLNKOV="chrome://extensions" ;; esac

if [ "$AKCIA" = nastavenie ]; then
  cat <<EOF

=== Nastavenie obrazovky AdNa (raz na tomto počítači) ===
1. Na stránke doplnkov zapnite „Režim pre vývojárov“ (vpravo hore alebo vľavo dole).
2. Kliknite „Načítať rozbalené“ a vyberte priečinok:
      $ROZ
   (ak tam doplnok „AdNa – TV prehrávač“ už je, nič nerobte)
3. Prepnite na kartu s obrazovkou, stlačte F5 a v TV zóne sa prihláste do Antik TV.
4. Zatvorte okno a obrazovku spúšťajte príkazom: $DIR/obrazovka-linux.sh
   Aby sa spúšťala sama po zapnutí: $DIR/obrazovka-linux.sh --autostart

EOF
  nohup "$PREH" "${SPOLOCNE[@]}" "$STRANKA_DOPLNKOV" "$SERVER/obrazovka/?hlas=test" >/dev/null 2>&1 &
  exit 0
fi

# obraz sa nevypína, kým beží obrazovka
command -v xset >/dev/null && { xset s off; xset -dpms; } 2>/dev/null || true
exec "$PREH" "${SPOLOCNE[@]}" --kiosk "$SERVER/obrazovka/" >/dev/null 2>&1
