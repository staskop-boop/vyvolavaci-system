#!/usr/bin/env bash
# Údržba servera Hetzner bez SSH kľúča (volá workflow .github/workflows/udrzba.yml; Pali to schválil 2026-11-09):
# cez Hetzner API vygeneruje nové jednorazové heslo roota (nikde sa neukladá ani nevypisuje), prihlási sa SSH,
# vypíše diagnostiku automatickej aktualizácie, vynúti aktualizáciu z main a obnoví plánovač (cron).
# Repozitár je verejný – vypisujú sa len bezpečné riadky (bez tokenov, hesiel a inštalačného kódu).
set -euo pipefail
SERVER_NAZOV="adna-vyvolavaci"
AKCIA="${AKCIA:-aktualizovat}"
chyba() { echo "::error::⚠ $*" >&2; exit 1; }
[ -n "${HCLOUD_TOKEN:-}" ] || chyba "Chýba tajomstvo HCLOUD_TOKEN."
hc() { local f; f=$(mktemp)
  HC_KOD=$(curl -sS -o "$f" -w '%{http_code}' -X "$1" "https://api.hetzner.cloud/v1$2" -H "Authorization: Bearer $HCLOUD_TOKEN" -H 'Content-Type: application/json' ${3:+--data "$3"})
  HC=$(cat "$f"); rm -f "$f"; }

hc GET "/servers?label_selector=app%3D$SERVER_NAZOV"
[ "$HC_KOD" = 200 ] || chyba "Hetzner API odmietlo token."
SID=$(jq -r '.servers[0].id // empty' <<<"$HC"); IP=$(jq -r '.servers[0].public_net.ipv4.ip // empty' <<<"$HC")
[ -n "$SID" ] || chyba "Server $SERVER_NAZOV sa nenašiel."
echo "server $SID, IP $IP"

hc POST "/servers/$SID/actions/reset_password"
[ "$HC_KOD" = 201 ] || { jq -c .error <<<"$HC" >&2 || true; chyba "Hetzner nevedel nastaviť jednorazové heslo (reset_password)."; }
PW=$(jq -r .root_password <<<"$HC"); echo "::add-mask::$PW"
AID=$(jq -r .action.id <<<"$HC")
for i in $(seq 1 40); do hc GET "/actions/$AID"; ST=$(jq -r .action.status <<<"$HC"); [ "$ST" = running ] || break; sleep 3; done
[ "$ST" = success ] || chyba "Nastavenie hesla skončilo stavom $ST."

export SSHPASS="$PW"
ssh_() { sshpass -e ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  -o PubkeyAuthentication=no -o PreferredAuthentications=password -o ConnectTimeout=20 "root@$IP" bash -s; }
FILTER='KÓD|KOD|TOKEN|[Tt]oken|heslo|HESLO|[Pp]assword'

echo "== Diagnostika =="
ssh_ <<'DIAG' 2>&1 | grep -Ev "$FILTER" || true
cd /opt/adna || { echo "chýba /opt/adna"; exit 0; }
echo "-- verzia na serveri: $(git rev-parse --short HEAD) ($(git log -1 --format=%cd --date=iso))"
git fetch -q origin main 2>&1 | tail -3
echo "-- najnovšia v main: $(git rev-parse --short origin/main)"
echo "-- zmeny v pracovnom priečinku:"; git status --short | head -10
echo "-- /etc/cron.d:"; ls -la /etc/cron.d/
echo "-- /etc/cron.d/adna:"; cat /etc/cron.d/adna 2>&1
echo "-- cron služba: $(systemctl is-active cron 2>&1)"
echo "-- posledné riadky /var/log/adna-aktualizacia.log:"; tail -40 /var/log/adna-aktualizacia.log 2>&1
echo "-- koniec inštalačného logu:"; tail -25 /var/log/adna-instalacia.log 2>&1
echo "-- cron v denníku:"; journalctl -u cron -n 10 --no-pager 2>&1 | tail -10
DIAG

if [ "$AKCIA" = aktualizovat ]; then
  echo "== Vynútená aktualizácia z main a obnova plánovača =="
  ssh_ <<'OPRAVA' 2>&1 | grep -Ev "$FILTER" || true
set -e
cd /opt/adna
git fetch -q origin main
git merge --ff-only origin/main || { echo "ff-only zlyhal – zarovnávam kód na origin/main (dáta a .env sú mimo gitu)"; git reset -q --hard origin/main; }
chmod +x deploy/vps/*.sh
DIR=/opt/adna
cat > /etc/cron.d/adna <<CRON
# denná záloha databázy o 22:30 do $DIR/deploy/data/zalohy
30 22 * * * root cd $DIR/deploy && docker compose exec -T adna node --disable-warning=ExperimentalWarning scripts/zaloha.js >/dev/null 2>&1
# každých 5 minút: ak je v GitHube (main) nová verzia, nasadí ju
*/5 * * * * root $DIR/deploy/vps/aktualizuj.sh --ak-zmena >> /var/log/adna-aktualizacia.log 2>&1
CRON
chmod 644 /etc/cron.d/adna
systemctl restart cron || true
$DIR/deploy/vps/aktualizuj.sh 2>&1 | tail -25
sleep 5
curl -fsS http://127.0.0.1:8080/api/health && echo
echo "-- verzia po aktualizácii: $(git rev-parse --short HEAD)"
OPRAVA
fi
