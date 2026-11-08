# Overenie – čo bolo naozaj otestované

Rozlišujeme tri úrovne:
* **Overené** – test reálne bežal a prešiel (výstup nižšie).
* **Simulované** – overené proti náhrade (simulovaná tlačiareň, Chromium namiesto WebView/Edge).
* **Vyžaduje fyzické zariadenie** – tu sa overiť nedalo.

## 1. Server – `cd server && npm test` → **25/25 prešlo**

Prideľovanie čísel A001, A002, …; idempotencia `requestId`; 100 súbežných registrácií = 100 jedinečných
po sebe idúcich čísel; 20 súbežných opakovaní tej istej požiadavky = 1 číslo; ochrana prihlásením;
vyvolanie / zopakovanie / vybavený / neprítomný / vrátenie; omylom vyvolané číslo zmizne z obrazovky;
poznámka personálu sa nedostane na verejné rozhranie; dve sestry naraz → 200 + 409; 10× súbežne
„Vyvolať ďalšieho“ → 10 rôznych pacientov; nastavenia a ambulancie; zmena hesla; ukončenie dňa a vymazanie
s potvrdením; deň podľa Europe/Bratislava (polnoc, letný/zimný čas); nový deň → A001, staré čísla v histórii;
**tvrdý reštart servera (SIGKILL)** – zachované čísla, stavy, vyvolania, nastavenia aj prihlásenie,
opakovaná požiadavka po reštarte vráti to isté číslo; WebSocket: úplný stav po pripojení, udalosti v reálnom čase,
odmietnutie neprihláseného, odpojenie po odhlásení.
Tlač (**simulovaná** sieťová ESC/POS tlačiareň cez TCP, `server/test/fake-printer.js`): obsah lístka (číslo,
AdNa, dátum a čas, pokyn, orezanie), chýba papier → `failed` a nič sa netlačí, bez odpovede → `unverified`,
nedostupná → `failed`, opakovanie po zlyhaní vytlačí ten istý lístok bez nového čísla, opakovaná tlač sestrou,
kódová stránka CP852, overenie stavu z administrácie.

## 2. Integrácia celého toku – `node tests/integracia.js` → **13/13 prešlo**

V jednom behu tri prehliadače (tablet s dotykom, PC sestry, TV 1920×1080) + server + simulovaná tlačiareň:
uvítanie na TV → dotyk na tablete → A001 na tablete → lístok A001 na tlačiarni → A001 sa objaví u sestry →
výber „Ambulancia č. 2“ a „Vyvolať ďalšieho“ → TV ukáže A001 a ambulanciu, prehrá signál → „Zopakovať“ →
signál znova → tablet sa sám vráti → dva tablety naraz → A002 a A003 → opakovaná tlač A002 bez nového čísla →
**vypnutie servera** → TV aj sestra ukážu výpadok, TV ponechá číslo → **zapnutie servera** → všetky tri sa
samy pripoja, stav je zachovaný, ďalšie číslo je A004 → žiadne chyby JavaScriptu.

## 3. Jednotlivé aplikácie (Playwright, Chromium)

| Aplikácia | Príkaz | Výsledok |
|---|---|---|
| SESTRA | `node apps/sestra/test/e2e.js` | **14/14** – prvotné nastavenie, prihlásenie, živé aktualizácie, všetky akcie, konflikt dvoch sestier, obnovenie stránky, reštart servera, nastavenia, opakovaná tlač, upozornenie na zlyhanú tlač, história, ukončenie dňa |
| TABLET | `ADNA_URL=… ADNA_SETUP_CODE=… node apps/tablet/test/e2e.js` | **14/14** – trojitý dotyk = 1 číslo, automatický návrat, stratená odpoveď → rovnaké číslo, výpadok → chyba a opakovanie s rovnakým `requestId`, všetky stavy tlače, offline indikátor |
| TV | `node apps/tv/test/e2e.js` | **11/11** – uvítanie, vyvolanie so zvukom, zopakovanie, história, stiahnutie omylom vyvolaného, obnovenie stránky bez opakovania zvuku, výpadok/obnova, zablokovaný zvuk → tlačidlo ovládané klávesom Enter, vypnutý zvuk |

„Zvuk“ v testoch = počítadlo spustení signálu (WebAudio); reálny výstup z reproduktora nikto nepočúval.

## 4. Android aplikácie – **čiastočne**

* Java zdrojové kódy tabletu aj TV sú **preložené kompilátorom `javac` proti Android 14 (API 34) rozhraniu**
  (bez chýb). Gradle wrapper je vygenerovaný.
* **APK neboli zostavené** – Android SDK a Android Gradle Plugin sa v tomto prostredí nedali stiahnuť.
  Zostavenie zdrojov (resources, manifest) a samotný beh na zariadení teda overené nie sú.

## 5. Vyžaduje fyzické zariadenie (neoverené)

* skutočná termálna tlačiareň: odpovede DLE EOT, kódová stránka CP852, veľkosť písma, orezanie;
* Android tablet: WebView, kiosk (Lock Task / device owner), pripnutie obrazovky, spustenie po zapnutí;
* Android TV: diaľkový ovládač, Leanback banner, zvuk vo WebView, automatické spustenie, overscan;
* Windows: PowerShell skripty pre PC sestry a server, Microsoft Edge v režime aplikácie.

Odporúčaný akceptačný test na mieste: [docs/AKCEPTACNY-TEST.md](AKCEPTACNY-TEST.md).
