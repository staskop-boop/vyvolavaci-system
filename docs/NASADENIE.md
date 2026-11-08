# Nasadenie: mini PC pri TV + doména vyvolavaci.adna.sk

Stav: **plán** (zatiaľ nenasadené). Tento dokument popisuje cieľové riešenie a podmienky, ktoré treba splniť
pred sprístupnením systému z internetu.

## Cieľové riešenie

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
4. DNS domény `adna.sk` presunúť (alebo len subdoménu delegovať) do Cloudflare – web a e-mail na Websupporte ostávajú.
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
