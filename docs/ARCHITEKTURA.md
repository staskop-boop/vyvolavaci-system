# Architektúra – vyvolávací systém AdNa

## Prehľad

```
                    lokálna sieť ambulancie (LAN / Wi-Fi)
 ┌──────────────────┐    HTTP + WebSocket    ┌──────────────────────────────┐
 │ TABLET (Android) │ ─────────────────────► │  SPOLOČNÝ SERVER (Node.js)   │
 │ app „AdNa Tablet“│ ◄───────────────────── │  Express + WebSocket (/ws)   │
 └──────────────────┘                        │  SQLite (WAL, data/adna.db)  │──TCP 9100──► sieťová termálna
 ┌──────────────────┐                        │  tlač ESC/POS                │             tlačiareň ESC/POS
 │ SESTRA (Windows) │ ─────────────────────► │  prihlásenie (scrypt, cookie)│
 │ Edge app-režim   │ ◄───────────────────── │                              │
 └──────────────────┘                        └──────────────────────────────┘
 ┌──────────────────┐                                    ▲
 │ TV (Android TV)  │ ───────────────────────────────────┘
 │ app „AdNa Obr.“  │
 └──────────────────┘
```

Server je jediný zdroj pravdy. Žiadna aplikácia neuchováva stav len u seba – po reštarte alebo
obnovení spojenia si vždy načíta úplný stav zo servera.

## Tri samostatné aplikácie

| Aplikácia | Zariadenie | Technológia | Zostavenie / nasadenie |
|---|---|---|---|
| **TABLET** (`apps/tablet/`) | tablet s Androidom 7+ v čakárni | natívny Android obal (Java) s celoobrazovkovým WebView + webové rozhranie `apps/tablet/web` | APK z Android Studia / Gradle; kiosk režim (Lock Task) |
| **SESTRA** (`apps/sestra/`) | počítače sestier s Windows 10/11 | webová aplikácia (PWA) spúšťaná v Microsoft Edge v režime samostatnej aplikácie | skript `Instalovat-AdNa-Sestra.ps1` na každom PC |
| **TV** (`apps/tv/`) | Android TV / Google TV / Android TV box | natívna Android TV aplikácia (Java, Leanback launcher) s WebView + webové rozhranie `apps/tv/web` | APK z Android Studia / Gradle; inštalácia cez adb alebo USB |

Prečo hybridný prístup (natívny obal + webové rozhranie zo servera):
* natívna časť rieši to, čo web nevie: kiosk režim, spustenie po zapnutí, celá obrazovka, zvuk bez
  kliknutia (WebView povolí prehrávanie bez gesta), nastavenie adresy servera diaľkovým ovládačom,
  natívnu chybovú obrazovku pri nedostupnom serveri;
* webová časť sa aktualizuje na všetkých zariadeniach naraz aktualizáciou servera, bez preinštalovania APK;
* tú istú webovú časť možno v núdzi otvoriť v ľubovoľnom prehliadači (záložné riešenie).

## Prečo tlačí server (a nie tablet)

Lístok sa tlačí na **sieťovej** ESC/POS tlačiarni, ktorú ovláda server:
* registrácia a tlač sú koordinované na jednom mieste – opakovaná požiadavka nikdy nevytvorí nové číslo
  a tlač sa zopakuje iba vtedy, ak predchádzajúci pokus zlyhal;
* sestra môže znovu vytlačiť lístok zo svojho počítača bez tabletu;
* logiku tlače a stavových dotazov (DLE EOT) bolo možné reálne otestovať so simulovanou tlačiarňou.

USB a Bluetooth tlačiarne pripojené priamo k tabletu **v1 nepodporuje** (pozri `docs/OBMEDZENIA.md`).
Rozhranie tlače (`server/src/printer.js`) je oddelené, takže ďalší spôsob pripojenia sa dá doplniť.

## Stack a rozhodnutia

* **Node.js 22.13+ (LTS), Express 4, `ws`** – jednoduché, rozšírené, beží na Windows aj Linuxe.
* **SQLite cez vstavaný modul `node:sqlite`** – žiadna natívna závislosť na kompiláciu, jeden súbor,
  režim WAL + `synchronous=FULL` (zápis je trvalý aj pri výpadku napájania).
* **Bez zostavovacieho kroku** vo webových častiach (čistý JavaScript) – inštalácia = skopírovať a spustiť.
* **WebSocket** pre aktualizácie v reálnom čase; po každom pripojení server pošle úplný stav, klienti sa
  pripájajú automaticky s rastúcim odstupom (1 → 10 s) a kontrolujú živosť spojenia (ping 15 s).

## Kľúčové mechanizmy

| Požiadavka | Riešenie |
|---|---|
| jedinečné vzostupné čísla | transakcia `BEGIN IMMEDIATE`, tabuľka `day_counters`, `UNIQUE(day, seq)` |
| žiadna duplicita pri opakovaní | tablet posiela `requestId` (UUID na jedno stlačenie); `UNIQUE(request_id)` |
| dve sestry, jeden pacient | podmienený zápis `UPDATE … WHERE status IN ('waiting','absent')` → druhá dostane 409 so správou |
| nový deň | deň podľa Europe/Bratislava; zoznam ukazuje len dnešné čísla, staré ostávajú v histórii |
| omylom vyvolané číslo | „Vrátiť medzi čakajúcich“ – číslo zmizne z obrazovky v čakárni |
| reštart servera | všetko je v SQLite; relácie sestier sú v DB (prežijú reštart) |
| zvuk zablokovaný prehliadačom | v Android TV app povolený; v prehliadači tlačidlo „Zapnúť zvuk“ + upozornenie |
| ochrana prístupu | scrypt heslá, HttpOnly SameSite=Strict cookie, limit pokusov, žiadne heslá v kóde |
| príprava na viac účtov | tabuľka `users` s rolou `staff`/`admin`, udalosti zaznamenávajú `user_id` |

Podrobný kontrakt: [API-KONTRAKT.md](API-KONTRAKT.md). Schéma: [schema.sql](schema.sql).

## Rozdelenie práce (agenti)

Hlavný agent navrhol dátový model, API kontrakt, udalosti a autentifikáciu, naprogramoval server
a databázu a napísal testy servera. Potom spustil troch samostatných subagentov (TABLET, SESTRA, TV),
každý pracoval vo vlastnom adresári `apps/…` podľa tohto kontraktu bez zásahu do servera. Hlavný agent
výsledky skontroloval, spojil a spustil integračný test celého toku (pozri [TESTY.md](TESTY.md)).
