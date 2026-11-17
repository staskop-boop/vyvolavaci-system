#!/usr/bin/env bash
# Nasadenie najnovšej verzie z GitHubu (vetva main) na lokálnom serveri.
#   sudo /opt/adna/deploy/lokalny/aktualizuj.sh             – nasadí vždy
#   sudo /opt/adna/deploy/lokalny/aktualizuj.sh --ak-zmena  – len ak je v main nový commit (cron každých 5 min)
set -euo pipefail
exec 9>/run/adna-aktualizacia.lock
flock -n 9 || exit 0
cd /opt/adna
git fetch -q origin main
if [ "${1:-}" = "--ak-zmena" ] && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then exit 0; fi
echo "== $(date '+%F %T') aktualizácia na $(git rev-parse --short origin/main) =="
git merge -q --ff-only origin/main
cd deploy/lokalny
docker compose exec -T adna node --disable-warning=ExperimentalWarning scripts/zaloha.js || true
docker compose up -d --build
docker image prune -f >/dev/null
docker compose ps
