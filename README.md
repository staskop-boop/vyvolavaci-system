# AdNa – vyvolávací systém pre ambulanciu

Vyvolávací systém čakárne ambulancie **AdNa s.r.o.** (cievna chirurgia, Košice). Aktuálna verzia: **3.1**.

Sestra pridelí pacientovi označenie (číslo alebo písmeno, napr. `7`, `A`, `K12`) a spáruje ho s plánovaným časom
vyšetrenia. Keď je pracovisko pripravené, sestra pacienta vo svojej aplikácii vyvolá. Na televízore v čakárni zaznie
signál (marimba), hlas povie napr. *„Číslo dvadsaťpäť, ambulancia jedna“* a veľkým písmom sa zobrazí označenie
a ambulancia, do ktorej má pacient vstúpiť. Zvyšok obrazovky patrí TV programu (Antik TV), panelu **Na rade**
s meškaním / predstihom voči plánovanému času a lište správ.

Systém je **anonymný** – nespracúva mená ani iné osobné údaje pacientov.

## Ako to celé funguje

```
                         ┌────────────────────── mini PC pri TV (Windows 11) ─────────────────────┐
  PC sestry č. 1 ──┐     │                                                                        │
  (app Sestra)     │ LAN │  server AdNa (Node.js, port 8080, databáza SQLite)                     │
  PC sestry č. 2 ──┼────►│        ▲                                                               │
  (app Sestra)     │     │        │ http://localhost:8080/obrazovka/                              │
  tablet (voliteľne)┘    │  Microsoft Edge na celú obrazovku ── HDMI ──► Samsung TV v čakárni     │
                         │                                                                        │
                         │  cloudflared (Cloudflare Tunnel) ──► https://vyvolavaci.adna.sk        │
                         └────────────────────────────────────────────────────────────────────────┘
```

| Časť | Priečinok | Kde beží | Čo robí |
|---|---|---|---|
| **Server** | `server/` | mini PC pri TV (alebo iné stále zapnuté PC) | databáza, API, WebSocket, slúži všetky webové aplikácie, tlač lístkov |
| **Sestra** | `apps/sestra/` | PC v pripravovniach – Edge v režime aplikácie | zoznam pacientov, „+ Pacient“, vyvolanie, hlásenie meškania, mimoriadny oznam, nastavenia |
| **TV (obrazovka)** | `apps/tv/` | mini PC → HDMI → Samsung TV | výzva s číslom a ambulanciou, hlas, Antik TV, panel Na rade, lišta správ |
| **Tablet** | `apps/tablet/` | Android tablet v čakárni (voliteľné) | samoobslužné číslo + tlač lístka na sieťovej ESC/POS tlačiarni |
| Spoločné | `shared/` | – | farby a písmo AdNa (`adna-theme.css`), klient API |

**Dve pripravovne:** každá má vlastné konto v aplikácii Sestra a vidí len svojich pacientov. *Ambulancia č. 1*
má na TV šípku vpravo, *Ambulancia č. 2* vľavo; pri čísle sa zobrazí aj meno lekára, ktoré sestra zadá ráno.

## Rýchly štart (skúška na jednom počítači)

Potrebujete **Node.js 22.13 alebo novší**.

```
cd server
npm ci
npm start
```

Server vypíše adresy a **inštalačný kód** (uloží ho aj do `server/data/SETUP-KOD.txt`). Potom otvorte v troch oknách:

* `http://localhost:8080/sestra/` – aplikácia Sestra (prvé prihlásenie inštalačným kódom, potom si nastavíte heslo),
* `http://localhost:8080/obrazovka/` – obrazovka v čakárni,
* `http://localhost:8080/tablet/` – tablet.

## Prevádzka v ambulancii

1. **Server na mini PC** – Node.js, priečinok s repozitárom napr. `C:\AdNa`, trvalý beh cez
   `server\scripts\Registrovat-ulohu-Windows.ps1` (spustí sa pri štarte, po páde sa reštartuje).
   Podrobne: [docs/INSTALACIA.md](docs/INSTALACIA.md).
2. **TV obrazovka** – na tom istom mini PC spúšťa `apps\tv\minipc\spustit-obrazovku.ps1` Microsoft Edge na celú
   obrazovku (Edge kvôli slovenskému ženskému hlasu *Viktória*; bez internetu záložný hlas *Filip*).
   Podrobne: [apps/tv/minipc/README.md](apps/tv/minipc/README.md).
3. **PC sestier** – inštalátor `apps\sestra\windows\Instalovat.cmd` vytvorí odkaz „AdNa Sestra“ (Edge `--app`).
   Podrobne: [apps/sestra/README.md](apps/sestra/README.md).
4. **Prístup z internetu** (plánované) – doména `vyvolavaci.adna.sk` cez **Cloudflare Tunnel** z mini PC,
   bez otvárania portov v routri. Plán a bezpečnostné podmienky: [docs/NASADENIE.md](docs/NASADENIE.md).

## Štruktúra repozitára

```
server/            Node.js server (Express, ws, vstavaný node:sqlite) + testy + skripty pre Windows/Linux
apps/sestra/       webová aplikácia Sestra + inštalátor pre Windows
apps/tv/           obrazovka v čakárni (web), mini PC skripty, Android TV obal (záloha)
apps/tablet/       tablet v čakárni (web) + Android obal (kiosk)
shared/            spoločné štýly a klient API
docs/              architektúra, API, databáza, inštalácia, dizajn (dizajn-v3 = definitívny dizajn TV)
tests/             integračný test celého toku
.github/workflows/ automatické testy servera a zostavenie APK
```

## Vývoj

* Vetvy: `main` je vždy funkčná verzia na nasadenie; zmeny idú cez vetvu a pull request.
* Pred commitom: `cd server && npm test` (45 testov). Testy obrazovky a integrácie potrebujú Playwright + Chromium:
  ```
  node apps/tv/test/e2e.js        # vyvolanie, zopakovanie, výpadok, zvuk
  node apps/tv/test/e2e-v2.js     # kartičky, plánované časy, Na rade
  node apps/tv/test/e2e-v21.js    # dve ambulancie, lekár, smer, meškanie, mimoriadny oznam
  node apps/sestra/test/e2e.js
  node apps/tablet/test/e2e.js
  node tests/integracia.js        # celý tok tablet → tlač → sestra → TV
  ```
* GitHub Actions pri každom pushi spustí testy servera a zostaví APK pre tablet a Android TV
  (záložka **Actions** → beh → *Artifacts*).
* API a databáza: [docs/API-KONTRAKT.md](docs/API-KONTRAKT.md), [docs/schema.sql](docs/schema.sql),
  architektúra: [docs/ARCHITEKTURA.md](docs/ARCHITEKTURA.md), dizajn: [docs/dizajn-v3/DIZAJN-MANUAL.md](docs/dizajn-v3/DIZAJN-MANUAL.md).
* Údaje servera (`server/data/` – databáza, logy, inštalačný kód) sa do repozitára **nikdy nedávajú**.

## Ďalšia dokumentácia

[Inštalácia](docs/INSTALACIA.md) · [Nasadenie s doménou](docs/NASADENIE.md) · [Testy](docs/TESTY.md) ·
[Situácie a výpadky](docs/SITUACIE.md) · [Obmedzenia](docs/OBMEDZENIA.md) ·
[Internet a bezpečnosť](docs/INTERNET-A-BEZPECNOST.md) · [Akceptačný test](docs/AKCEPTACNY-TEST.md) · [Dizajn](docs/DIZAJN.md)

## Pred ostrou prevádzkou

* súhlas Antiku s verejným premietaním v čakárni a licencie SOZA / LITA / SLOVGRAM,
* overiť na mieste: prehrávanie webtv.sk na mini PC, slovenský hlas v Edge, RSS zdroje správ.
