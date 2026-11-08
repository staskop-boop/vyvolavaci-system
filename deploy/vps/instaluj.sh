#!/usr/bin/env bash
# Jednorazová inštalácia servera AdNa na čistý VPS s Ubuntu 24.04 (napr. Hetzner).
# Ručne (ako root):  curl -fsSL https://raw.githubusercontent.com/staskop-boop/vyvolavaci-system/main/deploy/vps/instaluj.sh | bash
# Automaticky (cloud-init z workflow Nasadenie): token tunela a prvé heslo v súboroch
#   /root/adna-tunnel-token a /root/adna-heslo – po použití sa zmažú.
set -euo pipefail

REPO="https://github.com/staskop-boop/vyvolavaci-system.git"
DIR="/opt/adna"
TOKEN_FILE="/root/adna-tunnel-token"
HESLO_FILE="/root/adna-heslo"

[ "$(id -u)" = 0 ] || { echo "⚠ Spustite ako root (sudo)."; exit 1; }

echo "== 1/6 Aktualizácia systému a Docker =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl git ufw unattended-upgrades
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
timedatectl set-timezone Europe/Bratislava || true

echo "== 2/6 Firewall: otvorený len SSH (web ide cez Cloudflare Tunnel) =="
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

echo "== 3/6 Kód =="
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
cd "$DIR/deploy"
mkdir -p data && chown 1000:1000 data   # používateľ "node" v kontajneri

echo "== 4/6 Token tunela =="
if ! grep -qs '^TUNNEL_TOKEN=.\+' .env; then
  if [ -s "$TOKEN_FILE" ]; then TOKEN=$(tr -d '\r\n' < "$TOKEN_FILE")
  else read -rp "Vložte token tunela z Cloudflare (dlhý reťazec za --token): " TOKEN </dev/tty; fi
  umask 077
  printf 'TUNNEL_TOKEN=%s\n' "$TOKEN" > .env
fi
rm -f "$TOKEN_FILE"

echo "== 5/6 Spustenie =="
docker compose up -d --build
for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:8080/api/health && break; sleep 2; done

if [ -s "$HESLO_FILE" ]; then
  ADNA_NEW_PASSWORD=$(tr -d '\r\n' < "$HESLO_FILE") docker compose exec -T -e ADNA_NEW_PASSWORD adna \
    node --disable-warning=ExperimentalWarning src/cli.js
fi
rm -f "$HESLO_FILE"

echo "== 6/6 Záloha a automatická aktualizácia =="
cat > /etc/cron.d/adna <<CRON
# denná záloha databázy o 22:30 do $DIR/deploy/data/zalohy
30 22 * * * root cd $DIR/deploy && docker compose exec -T adna node --disable-warning=ExperimentalWarning scripts/zaloha.js >/dev/null 2>&1
# každých 5 minút: ak je v GitHube (main) nová verzia, nasadí ju
*/5 * * * * root $DIR/deploy/vps/aktualizuj.sh --ak-zmena >> /var/log/adna-aktualizacia.log 2>&1
CRON

echo
echo "Hotovo. Stav:"; docker compose ps
KOD=$(cat data/SETUP-KOD.txt 2>/dev/null || true)
[ -n "$KOD" ] && echo "INŠTALAČNÝ KÓD pre prvé prihlásenie do /sestra/:  $KOD"
echo "Otvorte https://vyvolavaci.adna.sk/sestra/"
