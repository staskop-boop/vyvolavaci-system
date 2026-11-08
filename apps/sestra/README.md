# AdNa Sestra – aplikácia pre počítače sestier (Windows)

Samostatná aplikácia, v ktorej sestra vidí čakajúcich pacientov a vyvoláva ich. Komunikuje iba so
spoločným serverom AdNa (`server/`), takže všetky počítače sestier, tablet a obrazovka v čakárni
vidia v každej chvíli ten istý stav.

## Čo aplikácia obsahuje

| Časť | Popis |
|---|---|
| `web/` | zdrojový kód aplikácie (HTML, CSS, JavaScript bez zostavovania). Server ju poskytuje na adrese `/sestra/`. |
| `windows/` | inštalačné skripty pre Windows (odkaz, ktorý otvorí aplikáciu v samostatnom okne). |
| `test/e2e.js` | automatický test celej aplikácie v prehliadači Chromium (Playwright). |

### Prečo takéto riešenie

Aplikácia je napísaná ako webová aplikácia a na počítači sestry beží v **samostatnom okne Microsoft
Edge v režime aplikácie** (bez kariet a panela s adresou, s vlastnou ikonou a vlastným profilom).

* Na počítač sa nič neinštaluje okrem odkazu – Edge je súčasťou Windows 10/11.
* Aktualizácia sa robí len na serveri; všetky počítače dostanú novú verziu pri ďalšom otvorení.
* Nehrozí, že by niektorý počítač ostal pri starej verzii a nebol kompatibilný so serverom.

Klasická „inštalácia ako aplikácia“ (PWA) cez ponuku Edge funguje **iba cez HTTPS**. V lokálnej sieti cez
obyčajné `http://` preto používame odkaz v režime aplikácie, ktorý vytvorí inštalačný skript. Ak neskôr
server sprístupníte cez HTTPS (pozri hlavnú dokumentáciu), môžete aplikáciu nainštalovať aj cez
Edge → `…` → *Aplikácie* → *Nainštalovať túto lokalitu ako aplikáciu* – súbor `manifest.webmanifest`
a ikony sú už pripravené.

## Nasadenie na každý počítač sestry

Predpoklady: Windows 10 alebo 11, Microsoft Edge, počítač je v rovnakej sieti ako server, server beží
(adresu vypíše server pri spustení, napr. `http://192.168.1.10:8080`).

1. Skopírujte priečinok `apps/sestra/windows` na počítač sestry (napr. na USB kľúči alebo zo zdieľaného priečinka).
2. Dvakrát kliknite na **`Instalovat.cmd`**.
   *Alebo* v PowerShelli:
   `powershell -ExecutionPolicy Bypass -File .\Instalovat-AdNa-Sestra.ps1 -ServerUrl http://192.168.1.10:8080 -Autostart`
3. Zadajte adresu servera (napr. `http://192.168.1.10:8080`). Skript overí, že server odpovedá.
4. Skript vytvorí odkaz **AdNa Sestra** na ploche a v ponuke Štart.
   S prepínačom `-Autostart` aj v priečinku *Po spustení* – aplikácia sa otvorí po prihlásení do Windows.
5. Spustite aplikáciu a prihláste sa heslom personálu.
6. V hornom paneli zvoľte **Ambulancia pre vyvolanie** a zaškrtnite **Predvolená pre tento počítač**.
   Táto voľba sa pamätá len na danom počítači.

Odinštalovanie: `Odinstalovat-AdNa-Sestra.ps1` (odstráni odkazy a voliteľne lokálny profil; údaje na serveri ostávajú).

Bez skriptu (napr. na skúšku) stačí v ľubovoľnom prehliadači otvoriť `http://ADRESA-SERVERA:8080/sestra/`.

Ak firewall na serveri blokuje port 8080, povoľte ho (pozri hlavnú dokumentáciu servera).

## Prvé spustenie – nastavenie hesla

Keď ešte nie je nastavené heslo, aplikácia zobrazí obrazovku **Prvotné nastavenie hesla personálu**:

1. Na počítači so serverom otvorte súbor `server/data/SETUP-KOD.txt` (kód je aj vo výpise konzoly servera).
2. Zadajte inštalačný kód a nové heslo (aspoň 10 znakov) dvakrát.
3. Po nastavení sa súbor s kódom automaticky vymaže a ste prihlásení.

Heslo sa ukladá iba ako odtlačok (scrypt so soľou), nikdy nie v čitateľnej podobe. Zabudnuté heslo
nastavíte na serveri príkazom `npm run nastav-heslo`. V prvej verzii je jedno spoločné konto `personal`.

## Denná práca

* **Vyvolať ďalšieho** – vyvolá najdlhšie čakajúceho do zvolenej ambulancie. Na obrazovke v čakárni
  sa zobrazí číslo a ambulancia a zaznie signál.
* **Vyvolať** pri konkrétnom čísle – ak nie je na rade, otvorí sa okno s výberom ambulancie a nepovinným
  dôvodom (napr. objednaný pacient). Dôvod vidí len personál v histórii, nikdy sa nezobrazí verejne.
* **Zopakovať** – znovu zobrazí a zvukom ohlási vyvolané číslo (pacient nereaguje).
* **Vybavený / Neprítomný** – ukončí vyvolanie.
* **Vrátiť** – vráti číslo medzi čakajúcich podľa pôvodného času príchodu. Použite, ak ste omylom vyvolali
  nesprávne číslo – zmizne aj z obrazovky v čakárni.
* **Tlač / Znovu vytlačiť lístok** – vytlačí lístok s tým istým číslom (napr. pacient lístok stratil alebo
  tlač zlyhala). Nové číslo sa nikdy nevytvorí.
* Upozornenia nad zoznamom: zlyhaná alebo neoverená tlač lístka, vypnutá tlač, nevybavené čísla z
  predchádzajúceho dňa (sú v **Histórii**, do nového dňa sa neprenášajú).
* Vpravo hore je stav spojenia: **Pripojené** / **Pripája sa…** / **Bez spojenia**. Bez spojenia sú
  tlačidlá vypnuté a aplikácia sa sama znovu pripojí a načíta aktuálny stav.

### Viac sestier naraz

Každá sestra môže mať aplikáciu otvorenú na svojom počítači (aj s tým istým kontom). Zmeny sa
zobrazujú všetkým okamžite. Ak sa dve sestry pokúsia vyvolať to isté číslo, server prijme iba prvé
vyvolanie; druhá sestra uvidí hlásenie *„Číslo A012 už medzičasom vyvolala iná sestra (Ambulancia č. 2).“*

## Nastavenia (administrácia)

Záložka **Nastavenia**: názvy a poradie ambulancií (pridanie, premenovanie, deaktivácia), názov
zariadenia, predpona čísla, čas zobrazenia čísla na tablete, zvuk na obrazovke, počet naposledy
vyvolaných čísel, text pokynu, sieťová tlačiareň (IP, port, diakritika, orezanie, zisťovanie stavu,
*Overiť tlačiareň*, *Skúšobná tlač*), zmena hesla, **Ukončiť deň** (potvrdenie slovom UKONČIŤ) a
**Vymazať údaje** (potvrdenie slovom VYMAZAŤ a heslom).

## Riešenie problémov

| Problém | Riešenie |
|---|---|
| „Server je nedostupný“ | Skontrolujte, či beží server a či je počítač v sieti ambulancie; overte adresu v `%LOCALAPPDATA%\AdNa\Sestra\server.txt`, prípadne spustite inštaláciu znova. |
| Stále „Pripája sa…“ | Firewall na serveri musí povoliť port 8080 (HTTP aj WebSocket). |
| Po čase žiada heslo znova | Prihlásenie platí 12 hodín od poslednej aktivity; po zmene hesla sa odhlásia ostatné počítače. |
| „Príliš veľa neúspešných pokusov“ | Po 5 nesprávnych heslách z jedného počítača počkajte 60 s. |
| Tlač zlyhala | Skontrolujte papier, kryt a sieťové pripojenie tlačiarne, potom *Znovu vytlačiť lístok*. |

## Overenie (test)

```
cd adna
node apps/sestra/test/e2e.js        # spustí vlastný server a falošnú ESC/POS tlačiareň
```

Test v Chromiu overí: prvotné nastavenie hesla, prihlásenie, živé zobrazenie nových čísel, vyvolanie
ďalšieho, zopakovanie, stavy, vrátenie, konflikt dvoch sestier, obnovenie stránky, reštart servera
s automatickým opätovným pripojením, nastavenia, overenie tlačiarne, opakovanú tlač bez nového čísla,
upozornenie pri nedostupnej tlačiarni, históriu, ukončenie dňa a odhlásenie.

## Obmedzenia prvej verzie

* Jedno spoločné konto personálu (architektúra servera má roly `staff`/`admin` pre neskoršie samostatné účty).
* Inštalačné skripty `.ps1` neboli spustené na skutočnom Windows (v prostredí vývoja nie je Windows ani PowerShell);
  overená je webová aplikácia v prehliadači Chromium, na ktorom je postavený aj Microsoft Edge.
* Režim aplikácie Edge nie je natívna desktopová aplikácia; bez spojenia so serverom aplikácia nepracuje
  (zámerne – stav musí byť spoločný pre všetky zariadenia).
