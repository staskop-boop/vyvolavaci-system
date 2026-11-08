#!/usr/bin/env bash
# Jednorazová inštalácia servera AdNa na čistý VPS s Ubuntu 24.04 (napr. Hetzner CX22).
# Spustenie ako root:  curl -fsSL https://raw.githubusercontent.com/staskop-boop/vyvolavaci-system/main/deploy/vps/instaluj.sh | bash
set -euo pipefail

REPO="https://github.com/staskop-boop/vyvolavaci-system.git"
DIR="/opt/adna"

[ "$(id -u)" = 0 ] || { echo "⚠ Spustite ako root (sudo)."; exit 1; }

echo "== 1/5 Aktualizácia systému a Docker =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl git ufw unattended-upgrades
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
timedatectl set-timezone Europe/Bratislava || true

echo "== 2/5 Firewall: otvorený len SSH (web ide cez Cloudflare Tunnel) =="
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

echo "== 3/5 Kód =="
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
cd "$DIR/deploy"
mkdir -p data && chown 1000:1000 data   # používateľ "node" v kontajneri

echo "== 4/5 Token tunela =="
if ! grep -qs '^TUNNEL_TOKEN=.\+' .env; then
  read -rp "Vložte token tunela z Cloudflare (dlhý reťazec za --token): " TOKEN </dev/tty
  printf 'TUNNEL_TOKEN=%s\n' "$TOKEN" > .env
  chmod 600 .env
fi

echo "== 5/5 Spustenie =="
docker compose up -d --build
# denná záloha databázy o 22:30 do deploy/data/zalohy
cat > /etc/cron.d/adna-zaloha <<CRON
30 22 * * * root cd $DIR/deploy && docker compose exec -T adna node --disable-warning=ExperimentalWarning scripts/zaloha.js >/dev/null 2>&1
CRON

sleep 5
echo
echo "Hotovo. Stav:"; docker compose ps
KOD=$(cat data/SETUP-KOD.txt 2>/dev/null || true)
[ -n "$KOD" ] && echo "INŠTALAČNÝ KÓD pre prvé prihlásenie do /sestra/:  $KOD"
echo "Otvorte https://vyvolavaci.adna.sk/sestra/"
