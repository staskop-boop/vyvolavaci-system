#!/usr/bin/env bash
# Prenos údajov zo súčasného servera (https://vyvolavaci.adna.sk, kým DNS ešte ukazuje naň) na tento lokálny server:
# kontá a heslá, nastavenia, dnešní pacienti, história a štatistiky. Spustiť ako root TESNE PRED prepnutím DNS,
# keď v ambulancii nikto nevyvoláva – čo sa na starom serveri zmení po prenose, na novom už nebude.
#   sudo bash /opt/adna/deploy/lokalny/prenos-udajov.sh [adresa starého servera]
# Pýta meno a heslo správcu (heslo skryto, nikam sa neukladá). Pôvodná databáza tohto servera sa odloží do zalohy/.
# Funguje pre oba spôsoby inštalácie: Docker (deploy/lokalny/instaluj.sh) aj server spustený priamo cez Node.js
# ako služba systemd (server/scripts/adna.service) – spôsob si zistí sám.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "⚠ Spustite ako root (sudo)."; exit 1; }
ZDROJ="${1:-https://vyvolavaci.adna.sk}"
koniec() { echo "⚠ $*" >&2; exit 1; }
caka_na_server() { for _ in $(seq 1 60); do curl -fsS -o /dev/null http://127.0.0.1:8080/api/health 2>/dev/null && return 0; sleep 2; done; return 1; }

# --- kde je kód a ako server beží ---
KOREN="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd || true)"
REZIM=""; SLUZBA="${ADNA_SLUZBA:-}"
[ -n "$SLUZBA" ] || SLUZBA=$(systemctl list-units --type=service --all --no-legend --plain 2>/dev/null | awk '{print $1}' | grep -i '^adna' | grep -vi 'aktualiz\|zaloh\|obrazovk' | head -1 || true)
[ -f "$KOREN/server/src/index.js" ] || KOREN="/opt/adna"
if [ ! -f "$KOREN/server/src/index.js" ] && [ -n "$SLUZBA" ]; then   # skript stiahnutý mimo repozitára: kód je tam, kde beží služba
  WD=$(systemctl show "$SLUZBA" -p WorkingDirectory --value 2>/dev/null || true)
  [ -f "$WD/src/index.js" ] && KOREN="$(dirname "$WD")"
fi
[ -f "$KOREN/server/src/index.js" ] || koniec "Nenašiel som kód servera AdNa (hľadal som pri skripte, v /opt/adna a podľa služby systemd)."
[ -f "$KOREN/server/scripts/stiahnut-zalohu.js" ] || koniec "Server ešte nemá najnovšiu verziu z GitHubu (chýba scripts/stiahnut-zalohu.js) – počkajte na aktualizáciu a skúste znova."
if [ -f "$KOREN/deploy/lokalny/data/adna.db" ] && command -v docker >/dev/null && (cd "$KOREN/deploy/lokalny" && docker compose ps -q adna 2>/dev/null | grep -q .); then
  REZIM=docker; DATA="$KOREN/deploy/lokalny/data"
else
  [ -n "$SLUZBA" ] || koniec "Nenašiel som službu servera (systemd, názov začínajúci na adna). Spustite s ADNA_SLUZBA=názov-služby."
  REZIM=sluzba
  DATA=$(systemctl show "$SLUZBA" -p Environment --value 2>/dev/null | tr ' ' '\n' | sed -n 's/^ADNA_DATA_DIR=//p' | head -1)
  DATA="${DATA:-$KOREN/server/data}"
  [ -f "$DATA/adna.db" ] || koniec "V $DATA nie je databáza adna.db – server asi používa iný priečinok údajov."
  NODE=$(command -v node || true); [ -n "$NODE" ] || koniec "Chýba program node."
fi
echo "server: $KOREN, spôsob: $REZIM${SLUZBA:+ ($SLUZBA)}, údaje: $DATA"
curl -fsS -o /dev/null http://127.0.0.1:8080/api/health || koniec "Tento server na http://127.0.0.1:8080 neodpovedá – najprv ho spustite."

if [ -z "${ADNA_HESLO:-}" ]; then   # (v automatickom teste prídu údaje z prostredia)
  read -rp "Meno správcu na $ZDROJ [admin]: " MENO </dev/tty; ADNA_MENO="${MENO:-admin}"
  read -rsp "Heslo správcu (nezobrazí sa): " ADNA_HESLO </dev/tty; echo
fi
export ADNA_ZDROJ="$ZDROJ" ADNA_MENO="${ADNA_MENO:-admin}" ADNA_HESLO

echo "== 1/3 Sťahujem zálohu zo $ZDROJ =="
if [ "$REZIM" = docker ]; then
  (cd "$KOREN/deploy/lokalny" && docker compose exec -T -e ADNA_ZDROJ -e ADNA_MENO -e ADNA_HESLO adna node --disable-warning=ExperimentalWarning scripts/stiahnut-zalohu.js)
else
  (cd "$KOREN/server" && ADNA_DATA_DIR="$DATA" "$NODE" --disable-warning=ExperimentalWarning scripts/stiahnut-zalohu.js)
fi
unset ADNA_HESLO
[ -s "$DATA/prenos.db" ] || koniec "Záloha sa nestiahla."

echo "== 2/3 Výmena databázy =="
if [ "$REZIM" = docker ]; then (cd "$KOREN/deploy/lokalny" && docker compose stop adna); else systemctl stop "$SLUZBA"; fi
# databáza sa smie vymeniť len pod zastaveným serverom
for _ in $(seq 1 15); do curl -fsS -o /dev/null -m 2 http://127.0.0.1:8080/api/health 2>/dev/null || { ZASTAVENY=1; break; }; sleep 2; done
if [ -z "${ZASTAVENY:-}" ]; then
  rm -f "$DATA/prenos.db"
  if [ "$REZIM" = docker ]; then (cd "$KOREN/deploy/lokalny" && docker compose up -d); else systemctl start "$SLUZBA" || true; fi
  koniec "Server sa nepodarilo zastaviť (na porte 8080 stále odpovedá) – databázu som nemenil."
fi
mkdir -p "$DATA/zalohy"
chown --reference="$DATA/adna.db" "$DATA/prenos.db" "$DATA/zalohy"
chmod --reference="$DATA/adna.db" "$DATA/prenos.db"
mv "$DATA/adna.db" "$DATA/zalohy/adna-pred-prenosom-$(date +%Y%m%d-%H%M%S).db"
rm -f "$DATA/adna.db-wal" "$DATA/adna.db-shm"
mv "$DATA/prenos.db" "$DATA/adna.db"

echo "== 3/3 Spustenie =="
if [ "$REZIM" = docker ]; then (cd "$KOREN/deploy/lokalny" && docker compose up -d); else systemctl start "$SLUZBA"; fi
caka_na_server || koniec "Server po výmene databázy neodpovedá (pôvodná databáza je v $DATA/zalohy/)."
echo "Hotovo – údaje sú prenesené. Teraz sa môže prepnúť adresa vyvolavaci.adna.sk na tento server."
