#!/usr/bin/env bash
# Inštalácia servera AdNa na lokálny Linux server v ambulancii (Debian / Ubuntu). Spustiť ako root:
#   curl -fsSL https://raw.githubusercontent.com/staskop-boop/vyvolavaci-system/main/deploy/lokalny/instaluj.sh -o /tmp/adna-instaluj.sh && sudo bash /tmp/adna-instaluj.sh
# Urobí: Docker (ak chýba), kód do /opt/adna, server na porte 8080, služba cloudflared s tokenom tunela
# „vyvolavaci-lokal“, denná záloha a automatická aktualizácia z main. Firewall ani ostatné služby nemení.
# Opakované spustenie je bezpečné. Token sa pýta skryto a nikam sa nevypisuje.
set -euo pipefail

REPO="https://github.com/staskop-boop/vyvolavaci-system.git"
DIR="/opt/adna"
[ "$(id -u)" = 0 ] || { echo "⚠ Spustite ako root (sudo)."; exit 1; }

echo "== 1/5 Potrebné programy =="
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -yq ca-certificates curl git
else
  for p in curl git; do command -v "$p" >/dev/null || { echo "⚠ Chýba program $p – nainštalujte ho a spustite skript znova."; exit 1; }; done
fi
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
docker compose version >/dev/null 2>&1 || { echo "⚠ Chýba „docker compose“ (doplnok Docker Compose v2)."; exit 1; }

echo "== 2/5 Kód =="
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
cd "$DIR/deploy/lokalny"
chmod +x ./*.sh
mkdir -p data && chown 1000:1000 data   # používateľ "node" v kontajneri

echo "== 3/5 Spustenie servera =="
docker compose up -d --build
OK=""
for i in $(seq 1 60); do if curl -fsS -o /dev/null http://127.0.0.1:8080/api/health 2>/dev/null; then OK=1; break; fi; sleep 2; done
[ -n "$OK" ] || { echo "⚠ Server na http://127.0.0.1:8080 neodpovedá – pozrite: docker compose logs adna"; exit 1; }
echo "server beží na http://127.0.0.1:8080"

echo "== 4/5 Cloudflare Tunnel (cloudflared) =="
if ! command -v cloudflared >/dev/null; then
  case "$(uname -m)" in x86_64) A=amd64;; aarch64|arm64) A=arm64;; *) echo "⚠ Nepodporovaný procesor $(uname -m) – nainštalujte cloudflared ručne."; exit 1;; esac
  curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$A"
  chmod +x /usr/local/bin/cloudflared
fi
if systemctl list-unit-files 2>/dev/null | grep -q '^cloudflared\.service'; then
  echo "služba cloudflared už je nainštalovaná ($(systemctl is-active cloudflared 2>/dev/null || true))"
else
  echo "Token tunela: Cloudflare Zero Trust → Networks → Tunnels → vyvolavaci-lokal → Configure → dlhý reťazec za „--token“."
  read -rsp "Vložte token (nezobrazí sa) a stlačte Enter: " TOKEN </dev/tty; echo
  TOKEN=$(printf %s "$TOKEN" | tr -d '[:space:]')
  [ "${#TOKEN}" -ge 50 ] || { echo "⚠ Token je príliš krátky – skopírujte celý reťazec za --token a spustite skript znova."; exit 1; }
  cloudflared service install "$TOKEN" >/dev/null
  unset TOKEN
  systemctl enable --now cloudflared >/dev/null 2>&1 || true
  echo "služba cloudflared nainštalovaná ($(systemctl is-active cloudflared 2>/dev/null || true))"
fi

echo "== 5/5 Záloha a automatická aktualizácia =="
cat > /etc/cron.d/adna <<CRON
# denná záloha databázy o 22:30 do $DIR/deploy/lokalny/data/zalohy
30 22 * * * root cd $DIR/deploy/lokalny && docker compose exec -T adna node --disable-warning=ExperimentalWarning scripts/zaloha.js >/dev/null 2>&1
# každých 5 minút: ak je v GitHube (main) nová verzia, nasadí ju
*/5 * * * * root $DIR/deploy/lokalny/aktualizuj.sh --ak-zmena >> /var/log/adna-aktualizacia.log 2>&1
CRON

echo
echo "Hotovo. Stav:"; docker compose ps
echo "Ďalší krok – prenos údajov zo súčasného servera (kontá, nastavenia, pacienti, história):"
echo "  sudo $DIR/deploy/lokalny/prenos-udajov.sh"
