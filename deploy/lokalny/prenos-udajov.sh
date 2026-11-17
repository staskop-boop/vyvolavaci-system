#!/usr/bin/env bash
# Prenos údajov zo súčasného servera (https://vyvolavaci.adna.sk, kým DNS ešte ukazuje naň) na tento lokálny server:
# kontá a heslá, nastavenia, dnešní pacienti, história a štatistiky. Spustiť ako root TESNE PRED prepnutím DNS,
# keď v ambulancii nikto nevyvoláva – čo sa na starom serveri zmení po prenose, na novom už nebude.
#   sudo /opt/adna/deploy/lokalny/prenos-udajov.sh
# Pýta meno a heslo správcu (heslo skryto, nikam sa neukladá). Pôvodná databáza tohto servera sa odloží do zalohy/.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "⚠ Spustite ako root (sudo)."; exit 1; }
cd /opt/adna/deploy/lokalny
ZDROJ="${1:-https://vyvolavaci.adna.sk}"

if [ -z "${ADNA_HESLO:-}" ]; then   # (v automatickom teste prídu údaje z prostredia)
  read -rp "Meno správcu na $ZDROJ [admin]: " MENO </dev/tty; ADNA_MENO="${MENO:-admin}"
  read -rsp "Heslo správcu (nezobrazí sa): " ADNA_HESLO </dev/tty; echo
fi
export ADNA_ZDROJ="$ZDROJ" ADNA_MENO="${ADNA_MENO:-admin}" ADNA_HESLO

echo "== 1/3 Sťahujem zálohu zo $ZDROJ =="
docker compose exec -T -e ADNA_ZDROJ -e ADNA_MENO -e ADNA_HESLO adna node --disable-warning=ExperimentalWarning scripts/stiahnut-zalohu.js
unset ADNA_HESLO

echo "== 2/3 Výmena databázy =="
docker compose stop adna
mkdir -p data/zalohy
[ -f data/adna.db ] && mv data/adna.db "data/zalohy/adna-pred-prenosom-$(date +%Y%m%d-%H%M%S).db"
rm -f data/adna.db-wal data/adna.db-shm
mv data/prenos.db data/adna.db
chown 1000:1000 data/adna.db

echo "== 3/3 Spustenie =="
docker compose up -d
OK=""
for i in $(seq 1 60); do if curl -fsS -o /dev/null http://127.0.0.1:8080/api/health 2>/dev/null; then OK=1; break; fi; sleep 2; done
[ -n "$OK" ] || { echo "⚠ Server po výmene databázy neodpovedá – pozrite: docker compose logs adna (pôvodná databáza je v data/zalohy/)."; exit 1; }
echo "Hotovo – údaje sú prenesené. Teraz sa môže prepnúť adresa vyvolavaci.adna.sk na tento server."
