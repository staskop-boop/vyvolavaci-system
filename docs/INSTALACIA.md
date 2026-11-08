# Inštalácia a spustenie

Postup v tomto poradí: **1. server → 2. heslo → 3. ambulancie a tlačiareň → 4. počítače sestier → 5. tablet → 6. televízor.**

## 1. Server (jeden počítač v ambulancii)

Server môže bežať na ľubovoľnom počítači, ktorý je počas ordinačných hodín stále zapnutý
(Windows 10/11 PC, mini PC, prípadne Linux). Odporúčame pevnú IP adresu (napr. `192.168.1.10`),
nastavenú v routeri (rezervácia DHCP).

1. Nainštalujte **Node.js 22 LTS alebo novší** (https://nodejs.org → „LTS“, verzia aspoň 22.13).
2. Skopírujte priečinok `adna` (celý balík) napr. do `C:\AdNa\`.
3. Otvorte príkazový riadok v `C:\AdNa\server` a spustite:
   ```
   npm ci --omit=dev
   npm start
   ```
   (alebo dvojklik na `server\scripts\spustit-server.bat`).
4. Server vypíše adresy rozhraní a **inštalačný kód** (uloží ho aj do `server\data\SETUP-KOD.txt`).
5. Trvalá prevádzka na Windows (spustenie pri štarte PC, automatický reštart po páde):
   PowerShell **ako správca** v `C:\AdNa\server\scripts`:
   ```
   powershell -ExecutionPolicy Bypass -File .\Registrovat-ulohu-Windows.ps1
   ```
   Skript zároveň povolí port 8080 vo firewalle pre súkromnú sieť.
   Linux: `server/scripts/adna.service` (systemd).
6. Overenie: v prehliadači `http://IP-SERVERA:8080/api/health` → `{"ok":true,…}`.

Údaje sú v `server\data\` (databáza `adna.db`, logy `logs\`). Záloha: `npm run zaloha`.
Voliteľné premenné prostredia: `ADNA_PORT` (predvolene 8080), `ADNA_HOST`, `ADNA_DATA_DIR`, `ADNA_SECURE_COOKIE=1` (za HTTPS proxy).

## 2. Prvotné bezpečné nastavenie hesla

V systéme **nie je žiadne predvolené heslo**. Pri prvom spustení:
1. Na počítači sestry otvorte `http://IP-SERVERA:8080/sestra/`.
2. Zobrazí sa „Prvotné nastavenie“. Zadajte **inštalačný kód** z konzoly servera alebo zo súboru
   `server\data\SETUP-KOD.txt` a dvakrát nové heslo (aspoň 10 znakov; odporúčame vetu, napr. `Modra-cakaren-2026!`).
3. Kód sa po použití zneplatní a súbor sa zmaže. Konto sa volá `personal` (spoločné konto v1).

Zabudnuté heslo: na serveri v `C:\AdNa\server` spustite `npm run nastav-heslo` (heslo sa zadáva skryto;
všetky prihlásenia sa zrušia). Zmena hesla bežne: *Nastavenia → Zmena hesla*.

## 3. Ambulancie a tlačiareň

Pri prvom spustení server vytvorí **ukážkové nastavenie troch ambulancií**:
`Ambulancia č. 1`, `Ambulancia č. 2`, `USG pracovisko`. Názvy sa upravujú v *Nastavenia → Ambulancie*.

Tlačiareň: pozri [apps/tablet/README.md](../apps/tablet/README.md) – časť „Tlačiareň lístkov“.
Stručne: sieťová termálna tlačiareň s ESC/POS, pevná IP, port 9100; v *Nastavenia → Tlačiareň* zadajte IP,
zapnite tlač, kliknite „Overiť tlačiareň“ a „Skúšobná tlač“.

## 4. Počítače sestier (Windows)

Pozri [apps/sestra/README.md](../apps/sestra/README.md).

## 5. Tablet v čakárni (Android)

Pozri [apps/tablet/README.md](../apps/tablet/README.md) a [apps/tablet/android/README.md](../apps/tablet/android/README.md).

## 6. Televízor v čakárni (Android TV / Google TV / TV box)

Pozri [apps/tv/README.md](../apps/tv/README.md) a [apps/tv/android/README.md](../apps/tv/android/README.md).

## Adresy rozhraní (náhradný spôsob – priamo v prehliadači)

| Rozhranie | Adresa |
|---|---|
| Sestra + nastavenia | `http://IP-SERVERA:8080/sestra/` |
| Tablet | `http://IP-SERVERA:8080/tablet/` |
| Obrazovka v čakárni | `http://IP-SERVERA:8080/obrazovka/` |

## Zostavenie APK

Android SDK nebolo v prostredí, kde vznikol tento kód, dostupné, preto APK súbory nie sú priložené.
Dve možnosti:
* **Android Studio** (Windows/Mac/Linux): *Open* → `apps/tablet/android` (resp. `apps/tv/android`) →
  *Build → Build App Bundle(s) / APK(s) → Build APK(s)*.
* **GitHub Actions**: ak kód nahráte do repozitára na GitHube, workflow `.github/workflows/zostavenie.yml`
  zostaví obe APK automaticky (záložka *Actions → Artifacts*).
