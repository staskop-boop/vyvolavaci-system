# AdNa Tablet – Android projekt

Natívna „obálka“ (Java, bez knižníc tretích strán) okolo webového rozhrania `/tablet/` zo servera AdNa.
Balík `sk.adna.tablet`, minSdk 24 (Android 7.0), targetSdk 34.

> Stav overenia: zdrojové kódy Java boli preložené (`javac`) proti rozhraniu Android 14 (API 34).
> **APK v prostredí vývoja nebolo zostavené** (Android SDK nebolo dostupné) a aplikácia nebola
> spustená na fyzickom tablete. Prvé zostavenie urobte podľa postupu nižšie.

## Zostavenie

### A) Android Studio (odporúčané)
1. Nainštalujte Android Studio (Koala alebo novšie).
2. *File → Open* → priečinok `apps/tablet/android`.
3. Studio stiahne Gradle 8.9, Android Gradle Plugin 8.5.2 a SDK 34 (potrebný internet).
4. *Build → Build App Bundle(s) / APK(s) → Build APK(s)* – vznikne
   `app/build/outputs/apk/debug/app-debug.apk`.

### B) Príkazový riadok
```bash
cd apps/tablet/android
# súbor local.properties s cestou k SDK, napr.: sdk.dir=C\:\\Users\\ja\\AppData\\Local\\Android\\Sdk
./gradlew assembleDebug        # Windows: gradlew.bat assembleDebug
./gradlew assembleRelease      # podpísaná verzia (pozri nižšie)
```

### Podpísanie release verzie
```bash
keytool -genkeypair -v -keystore adna-tablet.jks -alias adna -keyalg RSA -keysize 2048 -validity 10000
```
Vedľa `settings.gradle` vytvorte `keystore.properties` (do gitu ho **nedávajte**):
```
storeFile=adna-tablet.jks
storePassword=...
keyAlias=adna
keyPassword=...
```
Výsledok: `app/build/outputs/apk/release/app-release.apk`. Kľúč si bezpečne uschovajte – aktualizácie
musia byť podpísané rovnakým kľúčom.

## Inštalácia na tablet
1. Na tablete zapnite *Nastavenia → Informácie o tablete → 7× ťuknúť na Číslo zostavy* → *Možnosti pre vývojárov → Ladenie cez USB*.
2. `adb install -r app-release.apk` (alebo skopírujte APK do tabletu a nainštalujte ho – treba povoliť inštaláciu z neznámych zdrojov).
3. Pri prvom spustení zadajte **adresu servera** (napr. `http://192.168.1.10:8080`), overte spojenie a zvoľte **PIN správcu** (min. 4 číslice).

## Kiosk režim

| Spôsob | Čo robí | Nastavenie |
|---|---|---|
| **Správca zariadenia (odporúčané)** | Plný „Lock Task“ – pacient nemôže aplikáciu opustiť, žiadne potvrdzovanie | pozri nižšie |
| Pripnutie obrazovky | Android sa raz opýta na potvrdenie; odopnutie gestom Späť+Prehľad | prepínač v nastaveniach aplikácie |
| Domovská obrazovka | Tlačidlo Domov otvorí AdNa | prepínač v nastaveniach aplikácie, potom zvoliť „AdNa Tablet“ ako predvolenú domovskú aplikáciu |

**Správca zariadenia** (len na tablete bez prihláseného Google účtu, ideálne hneď po obnovení továrenských nastavení):
```bash
adb shell dpm set-device-owner sk.adna.tablet/.AdminReceiver
```
Zrušenie (napr. pred odinštalovaním): v aplikácii *Nastavenia → Ukončiť kiosk režim*, potom
`adb shell dpm remove-active-admin sk.adna.tablet/.AdminReceiver` (funguje len pre testovacie zostavenia
s `android:testOnly`; inak obnovenie továrenských nastavení). Zvážte to pred nasadením.

**Skryté nastavenia:** 5× rýchlo ťuknúť do ľavého horného rohu (do 3 s) → PIN správcu.
Po 5 nesprávnych PIN-och sa vstup na 60 s zablokuje. PIN je uložený len ako hash so soľou.

## Spustenie po zapnutí tabletu
Aplikácia reaguje na `BOOT_COMPLETED`. Android 10 a novší však spúšťanie aplikácií z pozadia obmedzuje,
preto automatické spustenie **nie je zaručené**. Spoľahlivo funguje, ak je aplikácia správcom zariadenia
alebo predvolenou domovskou obrazovkou. Overte to na konkrétnom tablete.

## Správanie pri výpadku
Ak server nie je dostupný pri načítaní, aplikácia ukáže vlastnú stránku „Registrácia je dočasne nedostupná“
a každých 5 s skúša `GET /api/health`; po obnovení načíta rozhranie automaticky. Výpadky počas registrácie
rieši webová časť (opakovanie s rovnakým identifikátorom požiadavky – nevznikne duplicitné číslo).
