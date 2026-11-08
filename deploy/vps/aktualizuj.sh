#!/usr/bin/env bash
# Nasadenie najnovšej verzie z GitHubu (vetva main). Spustenie: sudo /opt/adna/deploy/vps/aktualizuj.sh
set -euo pipefail
cd /opt/adna
git pull --ff-only
cd deploy
docker compose exec -T adna node --disable-warning=ExperimentalWarning scripts/zaloha.js || true
docker compose pull cloudflared
docker compose up -d --build
docker image prune -f >/dev/null
docker compose ps
