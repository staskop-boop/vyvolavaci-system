# Nasadenie: mini PC pri TV + doména vyvolavaci.adna.sk

Stav: **pripravené na nasadenie** (fáza 1 – VPS), zatiaľ nenasadené. Doména `adna.sk` už je v Cloudflare
(rovnako ako zamestnanci.adna.sk), Zero Trust tím ambulancie existuje.

Nasadenie má dve fázy, adresa `https://vyvolavaci.adna.sk` ostáva v oboch rovnaká:

1. **Hneď teraz – malý VPS (Hetzner) + Cloudflare Tunnel.** Server beží v Dockeri, do internetu nie je otvorený
   žiadny port, pred celou doménou je Cloudflare Access. Vhodné na skúšobnú prevádzku, kým nie je mini PC.
2. **Cieľovo – mini PC pri TV v ambulancii** (nižšie). Presun = kópia databázy + ten istý token tunela.

## Fáza 1: VPS + Cloudflare Tunnel (hneď)

```
 prehliadač / tablet / TV ──HTTPS──► Cloudflare (Access) ──tunel──► VPS: cloudflared ──► adna:8080 (Docker)
```

Súbory: `Dockerfile`, `deploy/docker-compose.yml`, `deploy/.env.example`, `deploy/vps/instaluj.sh`,
`deploy/vps/aktualizuj.sh`.

### Automaticky (odporúčané): workflow „Nasadenie vyvolavaci.adna.sk“

Jedno spustenie v GitHub Actions (`.github/workflows/nasadenie.yml` → `deploy/cloud/nasad.sh`) urobí v tomto poradí:
1. **Cloudflare Access** len pre registráciu pacientov (`/tablet`, `/api/kiosk`) – pustí e-maily správcu
   (predvolene stasko@adna.sk) a voliteľne verejnú IP ambulancie (tablet/kiosk bez prihlásenia).
   Personál sa prihlasuje **len menom a heslom v aplikácii** (rozhodnutie Paliho 2026-11-08); obrazovka je verejná
   (čísla a mená lekárov, žiadne údaje pacientov).
2. **Tunel** `vyvolavaci` so smerovaním `vyvolavaci.adna.sk → http://adna:8080`.
3. **DNS** CNAME `vyvolavaci` → tunel (existujúci iný záznam neprepíše).
4. **Server Hetzner** (Ubuntu 24.04, `cx23`, pri nedostupnosti ďalšie typy) so zálohami; cloud-init spustí
   `deploy/vps/instaluj.sh`, ktorý nastaví prvé heslo konta `personal` z tajomstva `ADNA_HESLO`.

Potrebné tajomstvá (Settings → Secrets and variables → Actions):
* `CLOUDFLARE_API_TOKEN` – vlastný token: Account › Cloudflare Tunnel › Edit, Account › Access: Apps and Policies › Edit,
  Zone › DNS › Edit a Zone › Zone › Read pre adna.sk;
* `HCLOUD_TOKEN` – Hetzner Cloud projekt → Security → API Tokens → Read & Write;
* `ADNA_HESLO` – prvé heslo konta `personal` (min. 10 znakov), po prihlásení ho zmeňte v aplikácii.

**Aktualizácie:** server každých 5 minút skontroluje vetvu `main` a novú verziu nasadí sám (pred tým urobí zálohu),
log `/var/log/adna-aktualizacia.log`. Zlúčenie PR = nasadenie.

### Ručne (ak nechcete Actions)

1. Zero Trust → Networks → Tunnels → Create → Cloudflared → `vyvolavaci`, skopírovať token; Public hostname
   `vyvolavaci.adna.sk` → HTTP → `adna:8080`. Zero Trust → Access → Applications → Self-hosted pre
   `vyvolavaci.adna.sk/tablet` a `vyvolavaci.adna.sk/api/kiosk` (politika s e-mailom správcu).
2. VPS s Ubuntu 24.04, prihlásiť sa `ssh root@IP` a spustiť:

```bash
curl -fsSL https://raw.githubusercontent.com/staskop-boop/vyvolavaci-system/main/deploy/vps/instaluj.sh | bash
```

Skript nainštaluje Docker, firewall (otvorené len SSH), stiahne kód do `/opt/adna`, vypýta token tunela,
spustí server + cloudflared, nastaví dennú zálohu (22:30) a automatickú aktualizáciu. Na konci vypíše
**inštalačný kód** pre prvé prihlásenie na `https://vyvolavaci.adna.sk/sestra/`.

Ručná aktualizácia: `sudo /opt/adna/deploy/vps/aktualizuj.sh`. Logy: `cd /opt/adna/deploy && docker compose logs -f adna`.

### Obmedzenia fázy 1

* **Sieťová tlačiareň v ambulancii nie je z VPS dosiahnuteľná** – tablet ukáže stav „tlač zlyhala“ a číslo
  na obrazovke. Kiosk s vlastnou tlačiarňou (tlač v Android aplikácii) tento problém nemá.
* Pri výpadku internetu v ambulancii systém nefunguje (vo fáze 2 v LAN áno).
* Údaje (len čísla, termíny, mená lekárov – žiadne mená pacientov) sú v dátovom centre Hetzner v EÚ.

### Kiosk

Kiosk (Sunmi / Mondo Novo, Android) bude používať rovnaký server ako tablet (`/tablet/` a `/api/kiosk/*`) –
v oboch fázach cez `https://vyvolavaci.adna.sk` (Access: IP ambulancie alebo prihlásenie e-mailom), vo fáze 2 aj priamo v LAN.
Tlač lístka bude v Android aplikácii kiosku, takže nezávisí od toho, kde beží server. Pred ostrou prevádzkou
kiosku doplniť párovanie zariadení (kľúč zariadenia) – pozri [INTERNET-A-BEZPECNOST.md](INTERNET-A-BEZPECNOST.md).

### Presun z VPS na mini PC (fáza 2)

1. Na VPS: `cd /opt/adna/deploy && docker compose exec adna node scripts/zaloha.js`, stiahnuť najnovší súbor
   z `deploy/data/zalohy/` (napr. WinSCP) a na mini PC uložiť ako `C:\AdNa\server\data\adna.db` (server vypnutý).
2. Na mini PC: `cloudflared service install <ten istý token>`; v Cloudflare zmeniť Public hostname na
   `http://localhost:8080`.
3. Na VPS `docker compose down`, server zrušiť.

## Fáza 2: mini PC v ambulancii (cieľové riešenie)

```
 Samsung TV ◄── HDMI ── mini PC (Windows 11, stále zapnutý)
                          ├── server AdNa (Node.js, 127.0.0.1:8080 alebo LAN:8080)
                          ├── Microsoft Edge na celú obrazovku → http://localhost:8080/obrazovka/
                          └── cloudflared (Cloudflare Tunnel) ──► https://vyvolavaci.adna.sk
 PC sestier (2 pripravovne) ── LAN alebo https://vyvolavaci.adna.sk/sestra/
```

* **Prečo mini PC:** Samsung TV (Tizen) nedovolí vlastnej aplikácii zobraziť Antik TV v okne. Mini PC kreslí celú
  obrazovku a TV slúži len ako monitor. Server beží na tom istom počítači, takže netreba ďalšie PC.
* **Prečo Cloudflare Tunnel:** hosting Websupport pre adna.sk podporuje len PHP, Node.js server na ňom nepobeží.
  Tunel vytvorí odchádzajúce spojenie z mini PC do Cloudflare – v routri sa **neotvárajú žiadne porty**
  a HTTPS certifikát zariadi Cloudflare.
* **Odporúčaný hardvér:** mini PC s Intel N100, 8 GB RAM, SSD, Windows 11 (~150 – 220 €), UPS.

## Postup (návrh)

1. Mini PC: nainštalovať Node.js 22 LTS, naklonovať repozitár do `C:\AdNa`, `cd server && npm ci --omit=dev`.
2. Trvalý beh servera: `server\scripts\Registrovat-ulohu-Windows.ps1` (ako správca).
3. Obrazovka: `apps\tv\minipc\spustit-obrazovku.ps1 -Server http://localhost:8080` v Plánovači úloh pri prihlásení,
   automatické prihlásenie Windows, vypnuté uspávanie.
4. DNS domény `adna.sk` už je v Cloudflare (hotové) – web a e-mail na Websupporte ostávajú.
5. Na mini PC nainštalovať `cloudflared` ako službu Windows a vytvoriť tunel `vyvolavaci` pre `vyvolavaci.adna.sk`.
6. Na serveri nastaviť `ADNA_SECURE_COOKIE=1` (len ak sestry pracujú cez `https://vyvolavaci.adna.sk`;
   pri prístupe cez `http://` v LAN by sa s touto voľbou neprihlásili).

## Bezpečnostné podmienky pred zverejnením (povinné)

Tablet a obrazovka dnes nepoužívajú prihlásenie (`/api/kiosk/*`, `/api/display/*`, `/ws?channel=display`).
V lokálnej sieti je to v poriadku, z internetu nie. Preto:

1. **Cloudflare Access** (Zero Trust, zadarmo do 50 používateľov) pred celou doménou – prístup len pre e-maily
   sestier / ambulancie, prihlásenie jednorazovým kódom.
2. V tuneli zverejniť len to, čo treba zvonka (aplikácia Sestra a jej API); `/api/kiosk/*`, `/tablet/` a
   `/obrazovka/` nechať dostupné len z LAN / localhost – v `cloudflared` cez pravidlá `ingress` s `path`
   alebo pravidlom WAF v Cloudflare.
3. Neskôr doplniť párovanie zariadení (kľúč zariadenia pre kiosk a obrazovku) – pozri
   [INTERNET-A-BEZPECNOST.md](INTERNET-A-BEZPECNOST.md).
4. Zálohy databázy (`npm run zaloha`) denne aj mimo mini PC.

## Otvorené otázky

* Má byť aplikácia Sestra dostupná aj mimo ambulancie, alebo stačí LAN a doména len na správu / vzdialenú pomoc?
* Kto spravuje DNS adna.sk (prístup do Websupportu) a Cloudflare účet ambulancie?
* Prehrávanie webtv.sk na mini PC a slovenský hlas v Edge treba overiť na mieste.
