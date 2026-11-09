#!/usr/bin/env bash
# Nasadenie vyvolavaci.adna.sk jedným spustením (volá ho workflow .github/workflows/nasadenie.yml).
# Poradie je dôležité: 1) Cloudflare Access  2) tunel  3) DNS  4) server Hetzner – adresa sa zverejní až za ochranou.
# Pali 2026-11-08: personál sa prihlasuje len menom a heslom v aplikácii (bez Cloudflare e-mailu). Access chráni
# iba registráciu pacientov (/tablet, /api/kiosk), aby z internetu nikto nevytváral čísla; obrazovka je verejná
# (čísla a mená lekárov, žiadne údaje pacientov). Pustí len EMAILY (správca) a voliteľne IP ambulancie.
# Opakované spustenie je bezpečné: existujúce časti sa aktualizujú, server sa druhýkrát nevytvorí.
#
# Premenné: CLOUDFLARE_API_TOKEN, HCLOUD_TOKEN, ADNA_HESLO (tajomstvá),
#           EMAILY (správca, čiarkou oddelené; predvolene stasko@adna.sk), IP_AMBULANCIE (voliteľné, aj viac čiarkou), TYP_SERVERA, LOKALITA
# Repozitár je verejný – skript nikdy nevypisuje tokeny ani heslo.
set -euo pipefail

HOST="vyvolavaci.adna.sk"
ZONA="adna.sk"
TUNEL="vyvolavaci"
APP_NAZOV="Vyvolávací systém AdNa"
POL_PERSONAL="Vyvolávací systém – správca"
POL_ZARIADENIA="Vyvolávací systém – zariadenia v ambulancii"
SERVER_NAZOV="adna-vyvolavaci"
LOKALITA="${LOKALITA:-nbg1}"
TYPY="${TYP_SERVERA:-cx23} cx22 cpx22 cpx21 cpx11"
# SERVER=hetzner (VPS v Dockeri, služba http://adna:8080) alebo SERVER=lokalny (server v ambulancii,
# cloudflared na tom istom PC → http://localhost:8080; token tunela si Pali skopíruje v Zero Trust → Tunnels)
SERVER="${SERVER:-hetzner}"
case "$SERVER" in hetzner) SLUZBA="http://adna:8080";; lokalny) SLUZBA="http://localhost:8080";; *) echo "::error::⚠ SERVER musí byť hetzner alebo lokalny" >&2; exit 1;; esac

chyba() { echo "::error::⚠ $*" >&2; exit 1; }
# všetky tajomstvá sa overia ešte pred prvou zmenou (nič sa nevytvorí, kým niektoré chýba)
POTREBNE="CLOUDFLARE_API_TOKEN"; [ "$SERVER" = hetzner ] && POTREBNE="$POTREBNE HCLOUD_TOKEN ADNA_HESLO"
for v in $POTREBNE; do [ -n "${!v:-}" ] || chyba "Chýba tajomstvo $v (Settings → Secrets and variables → Actions)."; done
[ "$SERVER" = lokalny ] || [ "${#ADNA_HESLO}" -ge 10 ] || chyba "ADNA_HESLO musí mať aspoň 10 znakov."
EMAILY="${EMAILY:-stasko@adna.sk}"

cf() { # cf METÓDA CESTA [JSON] → výsledok (.result), pri chybe koniec
  local out
  out=$(curl -sS -X "$1" "https://api.cloudflare.com/client/v4$2" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        -H 'Content-Type: application/json' ${3:+--data "$3"})
  if [ "$(jq -r '.success' <<<"$out")" != "true" ]; then
    echo "Cloudflare $1 $2:" >&2; jq -c '.errors' <<<"$out" >&2 || echo "$out" | head -c 500 >&2
    chyba "Cloudflare API odmietlo požiadavku (skontrolujte povolenia tokenu)."
  fi
  jq -c '.result' <<<"$out"
}
hc() { # hc METÓDA CESTA [JSON] → telo v $HC, HTTP kód v $HC_KOD (bez podprocesu, aby premenné ostali)
  local f; f=$(mktemp)
  HC_KOD=$(curl -sS -o "$f" -w '%{http_code}' -X "$1" "https://api.hetzner.cloud/v1$2" \
        -H "Authorization: Bearer $HCLOUD_TOKEN" -H 'Content-Type: application/json' ${3:+--data "$3"})
  HC=$(cat "$f"); rm -f "$f"
}

echo "== Cloudflare: zóna a účet =="
Z=$(cf GET "/zones?name=$ZONA")
ZONE_ID=$(jq -r '.[0].id // empty' <<<"$Z"); ACC=$(jq -r '.[0].account.id // empty' <<<"$Z")
[ -n "$ZONE_ID" ] || chyba "Zóna $ZONA sa nenašla – token musí mať Zone → Zone → Read pre $ZONA."
echo "zóna $ZONA ok"

echo "== 1/4 Cloudflare Access (ochrana registrácie pacientov) =="
INC_EMAIL=$(jq -cn --arg e "$EMAILY" '[$e | split(",")[] | gsub("\\s";"") | select(length>0) | {email:{email:.}}]')
[ "$(jq length <<<"$INC_EMAIL")" -gt 0 ] || chyba "Neplatný zoznam e-mailov."
POLITIKY=$(cf GET "/accounts/$ACC/access/policies?per_page=100")
politika() { # politika NÁZOV ROZHODNUTIE INCLUDE → id
  local body id
  body=$(jq -cn --arg n "$1" --arg d "$2" --argjson i "$3" '{name:$n, decision:$d, include:$i, session_duration:"24h"}')
  id=$(jq -r --arg n "$1" '.[] | select(.name==$n) | .id' <<<"$POLITIKY" | head -1)
  if [ -n "$id" ]; then cf PUT "/accounts/$ACC/access/policies/$id" "$body" >/dev/null; else id=$(cf POST "/accounts/$ACC/access/policies" "$body" | jq -r .id); fi
  echo "$id"
}
P1=$(politika "$POL_PERSONAL" allow "$INC_EMAIL")
APP_POL=$(jq -cn --arg p "$P1" '[{id:$p, precedence:1}]')
echo "politika správca: $(jq length <<<"$INC_EMAIL") e-mail(y)"
if [ -n "${IP_AMBULANCIE:-}" ]; then
  INC_IP=$(jq -cn --arg e "$IP_AMBULANCIE" '[$e | split(",")[] | gsub("\\s";"") | select(length>0) | {ip:{ip:(if test("/") then . elif test(":") then .+"/128" else .+"/32" end)}}]')
  P2=$(politika "$POL_ZARIADENIA" bypass "$INC_IP")
  APP_POL=$(jq -c --arg p "$P2" '. + [{id:$p, precedence:2}]' <<<"$APP_POL")
  echo "politika zariadenia: IP ambulancie bez prihlásenia"
fi
APP_BODY=$(jq -cn --arg n "$APP_NAZOV" --arg h "$HOST" --argjson p "$APP_POL" '
  {name:$n, domain:($h+"/tablet"), type:"self_hosted", session_duration:"24h", app_launcher_visible:false, policies:$p,
   destinations:[{type:"public", uri:($h+"/tablet")}, {type:"public", uri:($h+"/api/kiosk")}]}')
APP_ID=$(cf GET "/accounts/$ACC/access/apps?per_page=100" | jq -r --arg n "$APP_NAZOV" '.[] | select(.name==$n) | .id' | head -1)
if [ -n "$APP_ID" ]; then cf PUT "/accounts/$ACC/access/apps/$APP_ID" "$APP_BODY" >/dev/null; echo "aplikácia Access aktualizovaná"
else cf POST "/accounts/$ACC/access/apps" "$APP_BODY" >/dev/null; echo "aplikácia Access vytvorená"; fi

echo "== 2/4 Cloudflare Tunnel =="
TID=$(cf GET "/accounts/$ACC/cfd_tunnel?name=$TUNEL&is_deleted=false" | jq -r '.[0].id // empty')
if [ -z "$TID" ]; then TID=$(cf POST "/accounts/$ACC/cfd_tunnel" "$(jq -cn --arg n "$TUNEL" '{name:$n, config_src:"cloudflare"}')" | jq -r .id); echo "tunel vytvorený"; else echo "tunel existuje"; fi
cf PUT "/accounts/$ACC/cfd_tunnel/$TID/configurations" \
  "$(jq -cn --arg h "$HOST" --arg s "$SLUZBA" '{config:{ingress:[{hostname:$h, service:$s, originRequest:{}}, {service:"http_status:404"}]}}')" >/dev/null
TUNNEL_TOKEN=$(cf GET "/accounts/$ACC/cfd_tunnel/$TID/token" | jq -r .)
echo "::add-mask::$TUNNEL_TOKEN"
echo "smerovanie $HOST → $SLUZBA nastavené"

echo "== 3/4 DNS =="
CIEL="$TID.cfargotunnel.com"
REC=$(cf GET "/zones/$ZONE_ID/dns_records?name=$HOST")
if [ "$(jq length <<<"$REC")" -eq 0 ]; then
  cf POST "/zones/$ZONE_ID/dns_records" "$(jq -cn --arg h "$HOST" --arg c "$CIEL" '{type:"CNAME", name:$h, content:$c, proxied:true, comment:"Vyvolávací systém AdNa – Cloudflare Tunnel"}')" >/dev/null
  echo "CNAME $HOST vytvorený"
elif [ "$(jq -r '.[0].type + " " + .[0].content' <<<"$REC")" = "CNAME $CIEL" ]; then echo "CNAME $HOST už existuje"
else chyba "Pre $HOST už existuje iný DNS záznam ($(jq -r '.[0].type + " " + .[0].content' <<<"$REC")) – neprepisujem, rozhodnite ručne."; fi

if [ "$SERVER" = lokalny ]; then
  ST=$(cf GET "/accounts/$ACC/cfd_tunnel/$TID" | jq -r .status)
  {
    echo "### Vyvolávací systém AdNa – lokálny server"
    echo "* Tunel **$TUNEL** je pripravený (stav: **$ST**), smeruje na $SLUZBA."
    echo "* Na serveri v ambulancii spustite príkaz z Zero Trust → Networks → Tunnels → $TUNEL → Configure (cloudflared service install …)."
    echo "* Potom: https://$HOST/sestra/"
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  echo "Cloudflare je pripravené (tunel: $ST). Na lokálnom serveri nainštalujte cloudflared s tokenom z Zero Trust → Tunnels → $TUNEL."
  exit 0
fi

echo "== 4/4 Server Hetzner =="
hc GET "/servers?label_selector=app%3D$SERVER_NAZOV"; S=$HC
[ "$HC_KOD" = 200 ] || { jq -c '.error' <<<"$S" >&2 || true; chyba "Hetzner API odmietlo token (HCLOUD_TOKEN, Read & Write)."; }
SID=$(jq -r '.servers[0].id // empty' <<<"$S")
if [ -n "$SID" ]; then
  echo "server už existuje ($(jq -r '.servers[0].server_type.name' <<<"$S"), $(jq -r '.servers[0].public_net.ipv4.ip' <<<"$S")) – aktualizuje sa sám z main"
else
  UD=$(jq -rn --arg t "$(printf %s "$TUNNEL_TOKEN" | base64 -w0)" --arg h "$(printf %s "$ADNA_HESLO" | base64 -w0)" '
"#cloud-config
write_files:
  - path: /root/adna-tunnel-token
    permissions: \"0600\"
    encoding: b64
    content: \($t)
  - path: /root/adna-heslo
    permissions: \"0600\"
    encoding: b64
    content: \($h)
runcmd:
  - [bash, -c, \"curl -fsSL https://raw.githubusercontent.com/staskop-boop/vyvolavaci-system/main/deploy/vps/instaluj.sh | bash > /var/log/adna-instalacia.log 2>&1\"]
"')
  for TYP in $TYPY; do
    BODY=$(jq -cn --arg n "$SERVER_NAZOV" --arg t "$TYP" --arg l "$LOKALITA" --arg u "$UD" \
      '{name:$n, server_type:$t, image:"ubuntu-24.04", location:$l, user_data:$u, labels:{app:$n}, public_net:{enable_ipv4:true, enable_ipv6:true}}')
    hc POST /servers "$BODY"; R=$HC
    if [ "$HC_KOD" = 201 ]; then SID=$(jq -r .server.id <<<"$R"); echo "server vytvorený: $TYP v $LOKALITA, IP $(jq -r .server.public_net.ipv4.ip <<<"$R")"; break; fi
    echo "typ $TYP nedostupný: $(jq -r '.error.code + " – " + .error.message' <<<"$R")"
  done
  [ -n "$SID" ] || chyba "Hetzner nevytvoril žiadny server (skúste inú lokalitu: fsn1, hel1)."
  hc POST "/servers/$SID/actions/enable_backup"
  case "$HC_KOD" in 20[01]) true;; *) false;; esac && echo "zálohy Hetzner zapnuté" || echo "zálohy Hetzner sa nepodarilo zapnúť (HTTP $HC_KOD) – zapnite ich v konzole"
fi

echo "== Čakám na spojenie tunela (inštalácia trvá 3 – 8 min) =="
for i in $(seq 1 60); do
  ST=$(cf GET "/accounts/$ACC/cfd_tunnel/$TID" | jq -r .status)
  [ "$ST" = healthy ] && break
  sleep 15
done
echo "stav tunela: $ST"
{
  echo "### Vyvolávací systém AdNa"
  echo "* Adresa: https://$HOST/sestra/ (konto **personal**, heslo z tajomstva ADNA_HESLO)"
  echo "* Obrazovka: https://$HOST/obrazovka/"
  echo "* Stav tunela: **$ST**"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
[ "$ST" = healthy ] || chyba "Tunel sa zatiaľ nepripojil – server sa možno ešte inštaluje. Spustite workflow znova o pár minút."
echo "Hotovo: https://$HOST/sestra/"
