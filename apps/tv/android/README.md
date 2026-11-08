# AdNa Obrazovka – Android TV projekt

Samostatná Android aplikácia pre televízor s Android TV / Google TV alebo pre Android TV box.
Je to natívny „obal“ (Java, bez externých knižníc), ktorý na celej obrazovke zobrazuje stránku
`http://SERVER:8080/obrazovka/` zo spoločného servera AdNa.

| Položka | Hodnota |
|---|---|
| Balík (applicationId) | `sk.adna.obrazovka` |
| Minimálny Android | 6.0 (API 23) |
| Cieľový Android | 14 (API 34) |
| Zostavenie | Gradle 8.9 (wrapper), Android Gradle Plugin 8.5.2, JDK 17 alebo novší |
| Závislosti | žiadne (iba Android SDK) |

> **Stav overenia:** zdrojový kód v Jave bol skontrolovaný kompilátorom proti rozhraniu Android API 34
> (bez chýb). **APK v našom vývojovom prostredí zostavené nebolo** (nebolo dostupné Android SDK)
> a aplikácia ešte nebola spustená na skutočnom televízore. Pred nasadením ju zostavte a vyskúšajte podľa tohto návodu.

## 1. Zostavenie APK

### Možnosť A – Android Studio (odporúčané)
1. Nainštalujte [Android Studio](https://developer.android.com/studio) (obsahuje JDK aj Android SDK).
2. *File → Open…* a vyberte priečinok `apps/tv/android`.
3. Počkajte na synchronizáciu Gradle (prvýkrát stiahne potrebné súčasti z internetu).
4. *Build → Build App Bundle(s) / APK(s) → Build APK(s)*. Výsledok:
   `app/build/outputs/apk/debug/app-debug.apk` – na vyskúšanie stačí.
5. Pre trvalú prevádzku vytvorte podpísanú verziu: *Build → Generate Signed App Bundle / APK… → APK*.

### Možnosť B – príkazový riadok
Potrebujete JDK 17+ a Android SDK (premenná `ANDROID_HOME` alebo súbor `local.properties`
s riadkom `sdk.dir=C:\\Users\\...\\AppData\\Local\\Android\\Sdk`).

```bash
cd apps/tv/android
./gradlew assembleDebug        # Windows: gradlew.bat assembleDebug
./gradlew assembleRelease      # podpísaná verzia (pozri nižšie)
```

### Podpisovanie (release)
Jednorazovo vytvorte kľúč a **bezpečne ho uschovajte** (bez neho nevydáte aktualizáciu):
```bash
keytool -genkeypair -v -keystore adna-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias adna
```
Vedľa `settings.gradle` vytvorte súbor `keystore.properties` (nedávajte ho do Gitu):
```
storeFile=adna-release.jks
storePassword=...
keyAlias=adna
keyPassword=...
```
`./gradlew assembleRelease` potom vytvorí `app/build/outputs/apk/release/app-release.apk`.

## 2. Inštalácia na televízor / TV box

### a) Cez sieť pomocou adb (odporúčané pre správcu)
1. Na TV: *Nastavenia → Systém → Informácie* → 7× stlačte **Zostava (Build)** → zapnú sa vývojárske možnosti.
2. *Nastavenia → Systém → Pre vývojárov* → zapnite **Ladenie USB** a ak je k dispozícii, **Ladenie cez sieť**.
3. Zistite IP adresu TV (*Nastavenia → Sieť*).
4. Na počítači (Android SDK Platform Tools):
   ```bash
   adb connect 192.168.1.60:5555
   adb install -r app-release.apk
   ```
   Na TV potvrďte povolenie ladenia z tohto počítača.

### b) USB kľúčom
1. Skopírujte APK na USB kľúč a pripojte ho k TV.
2. Nainštalujte si v TV správcu súborov (napr. z Google Play) a v nastaveniach povoľte tomuto správcovi
   **Inštalovať neznáme aplikácie**.
3. Otvorte APK v správcovi súborov a potvrďte inštaláciu.

## 3. Prvé spustenie a adresa servera
1. Aplikácia **AdNa Obrazovka** sa objaví v zozname aplikácií (na Android TV v rade aplikácií s bannerom).
2. Pri prvom spustení sa otvorí obrazovka **Nastavenia**:
   * šípkami prejdite na pole *Adresa servera*, stlačte **OK** a klávesnicou na obrazovke zadajte IP adresu
     servera, napr. `192.168.1.10` (port `8080` sa doplní automaticky; inak zadajte celú adresu
     `http://192.168.1.10:8080`),
   * **Otestovať spojenie** – musí sa zobraziť „Spojenie je v poriadku.“,
   * **Uložiť a spustiť**.
3. Nastavenia neskôr otvoríte tlačidlom **MENU** (alebo tlačidlom Nastavenia / ozubeným kolesom, ak ho ovládač
   posiela do aplikácie) alebo **dlhým podržaním OK (1,5 s)**.

Odporúčame serveru prideliť v routeri pevnú IP adresu (rezerváciu DHCP).

## 4. Ovládanie diaľkovým ovládačom
| Tlačidlo | Akcia |
|---|---|
| OK (krátko) | v prehliadači aktivuje zvuk, ak je zablokovaný (v aplikácii nie je potrebné) |
| OK (podržať 1,5 s), MENU | nastavenia |
| Späť 2× do 2 s | ukončenie aplikácie (jedno stlačenie zobrazí iba upozornenie – ochrana pred omylom) |

## 5. Spúšťanie po zapnutí zariadenia
V nastaveniach je voľba **Spúšťať po zapnutí zariadenia** (predvolene zapnutá). Aplikácia po štarte systému
prijme udalosť `BOOT_COMPLETED` a pokúsi sa otvoriť obrazovku.

**Nie je to zaručené na každom zariadení:**
* Android 10 a novší obmedzuje spúšťanie aplikácií na pozadí. Na mnohých TV boxoch to napriek tomu funguje,
  na niektorých televízoroch (najmä s Google TV) nie.
* Pomôcť môže povolenie „Zobrazovať cez iné aplikácie“ – tlačidlo **Povoliť spúšťanie po zapnutí** v nastaveniach.
  Ak TV túto obrazovku nemá, povolenie sa dá udeliť cez adb:
  ```bash
  adb shell appops set sk.adna.obrazovka SYSTEM_ALERT_WINDOW allow
  ```
* Niektorí výrobcovia majú vlastné nastavenie „Automatické spustenie“ / „Autostart“ – povoľte ho pre AdNa Obrazovka.
* Niektoré TV boxy umožňujú zvoliť aplikáciu ako predvolený domovský launcher alebo „aplikáciu po zapnutí“
  (*Nastavenia → Aplikácie → Predvolené*) – vtedy je spustenie najspoľahlivejšie.
* Ak nič z toho nefunguje, po zapnutí TV stačí aplikáciu spustiť ručne – stav sa načíta zo servera automaticky.

Na televízore tiež vypnite šetrič obrazovky / „Ambient mode“ a automatické vypnutie, alebo nastavte dlhý čas
(aplikácia drží obrazovku zapnutú, ale niektoré TV majú vlastný časovač vypnutia).

## 6. Odolnosť
* Ak server nie je dostupný, zobrazí sa natívna obrazovka „Obrazovka AdNa sa pripája k serveru…“ a pokus
  sa opakuje každých 5 s.
* Po načítaní stránky sa o opätovné pripojenie (WebSocket) stará samotná stránka; pri výpadku zobrazí nenápadné
  upozornenie a po obnovení načíta stav.
* Každých 30 s aplikácia kontroluje, či stránka žije; ak nie, načíta ju znova. Pád procesu WebView aplikáciu neukončí.

## Štruktúra projektu
```
app/src/main/AndroidManifest.xml               – Leanback launcher, oprávnenia, BOOT_COMPLETED
app/src/main/java/sk/adna/obrazovka/
    MainActivity.java      – celoobrazovkový WebView, ovládač, chybová obrazovka, kontrola živosti
    SettingsActivity.java  – adresa servera, test spojenia, automatické spustenie
    BootReceiver.java      – spustenie po zapnutí
    Prefs.java             – uložené nastavenia, úprava adresy
app/src/main/res/drawable/banner.xml           – dočasný banner (nie oficiálne logo)
app/src/main/res/xml/network_security_config.xml – povolené HTTP v lokálnej sieti
```
Oficiálne logo: nahraďte `res/drawable/banner.xml` obrázkom `res/drawable-xhdpi/banner.png` (320 × 180 px)
a `ic_launcher.xml` ikonou.
