# Aplikácia 1 – Tablet pre pacientov a tlač lístkov

Pacient v čakárni stlačí **„Prihlásiť sa“**, server mu pridelí poradové číslo (napr. `A001`),
na sieťovej termálnej tlačiarni sa vytlačí lístok a číslo sa zobrazí aj na tablete. Po nastavenom čase
(predvolene 15 s) alebo tlačidlom **„Hotovo“** sa tablet vráti na úvodnú obrazovku. Registrácia je anonymná.

## Z čoho sa aplikácia skladá

| Časť | Priečinok | Popis |
|---|---|---|
| Android aplikácia „AdNa Tablet“ | `android/` | kiosk obálka: celá obrazovka, zámok aplikácie, nastavenie adresy servera, PIN správcu, stránka pri výpadku, spustenie po zapnutí |
| Webové rozhranie | `web/` | obrazovky Úvod → Spracovanie → Číslo / Chyba; servíruje ho server na `/tablet/` |
| Test | `test/e2e.js` | automatický test rozhrania a tlače so simulovanou tlačiarňou |

**Prečo takto:** rozhranie sa aktualizuje spolu so serverom bez preinštalovania tabletu a dá sa otestovať
aj v prehliadači (`http://SERVER:8080/tablet/`). Android časť rieši to, čo prehliadač nevie: kiosk režim,
spustenie po zapnutí a odolnosť pri výpadku.

**Tlač robí server, nie tablet.** Tablet pošle požiadavku na číslo; server číslo pridelí, odošle lístok
na sieťovú ESC/POS tlačiareň a vráti tabletu výsledok tlače. Vďaka tomu môže sestra lístok kedykoľvek
znovu vytlačiť zo svojho počítača a tablet nepotrebuje ovládač tlačiarne.

## Tlačiareň – požiadavky

* Termálna pokladničná tlačiareň s **ethernetom alebo Wi-Fi** a podporou príkazov **ESC/POS**
  (tlač „RAW“ na **TCP port 9100**). Šírka papiera 80 mm alebo 58 mm.
* **Pevná IP adresa** (rezervácia v DHCP routera alebo statické nastavenie v tlačiarni).
* Odporúčané: podpora stavových príkazov **DLE EOT** (zistenie chýbajúceho papiera, otvoreného krytu, chyby).
  Bez nich systém tlač odošle, ale nevie ju overiť (pozri nižšie).
* Odporúčané: automatický orez (príkaz `GS V`). Ak ho tlačiareň nemá, vypnite „Orezať“ v nastaveniach.
* **Nie je overený žiadny konkrétny model.** Implementácia bola otestovaná proti simulovanej tlačiarni;
  pred nasadením urobte skúšobnú tlač.
* **USB a Bluetooth tlačiarne pripojené k tabletu nie sú v 1. verzii podporované.**

### Nastavenie tlačiarne
1. Pripojte tlačiareň do siete ambulancie, zistite jej IP adresu (väčšina tlačiarní ju vytlačí pri zapnutí
   s podržaným tlačidlom FEED – podľa manuálu).
2. V aplikácii sestry otvorte **Nastavenia → Tlačiareň**: zapnite tlač, zadajte IP adresu a port (9100).
3. **Kódovanie:** predvolene „bez diakritiky“ (funguje na každej tlačiarni). Pre slovenské znaky zvoľte
   **CP852** a číslo kódovej stránky podľa manuálu tlačiarne (Epson: 18; iné modely sa líšia).
4. Stlačte **Skontrolovať tlačiareň** a **Skúšobná tlač**.

### Lístok obsahuje
názov **AdNa**, „Vaše poradové číslo“, **veľké číslo** (7× zväčšené písmo), dátum a čas registrácie,
pokyn „Posaďte sa, prosím, a sledujte obrazovku v čakárni.“, voliteľnú pätičku; pri opätovnej tlači
poznámku „(opakovaná tlač)“.

### Čo sa stane, keď…

| Situácia | Čo zistí server | Čo uvidí pacient | Čo uvidí sestra |
|---|---|---|---|
| tlač v poriadku a tlačiareň hlási stav | `ok` | „Lístok sa tlačí, vezmite si ho.“ | stav Vytlačený |
| tlačiareň nepodporuje / neodpovedá na stavový dotaz | `unverified` | „Ak sa lístok nevytlačil, zapamätajte si číslo alebo sa obráťte na sestru.“ | upozornenie *Tlač neoverená* – systém **netvrdí**, že sa vytlačilo |
| chýba papier, otvorený kryt, chyba tlačiarne | `failed` (nič sa netlačí) | „Lístok sa nepodarilo vytlačiť. Zapamätajte si, prosím, svoje číslo. Sestra je informovaná.“ | upozornenie a tlačidlo **Znovu vytlačiť** |
| tlačiareň vypnutá / nedostupná v sieti | `failed` (po ~3 s) | ako vyššie | ako vyššie |
| spojenie sa preruší počas tlače | `unverified` | neutrálny pokyn | upozornenie |
| papier dôjde počas tlače | `unverified` | neutrálny pokyn | upozornenie „lístok sa nemusel vytlačiť celý“ |

Číslo pacienta **vždy ostáva platné** aj pri zlyhaní tlače. Opätovná tlač (sestra → **Znovu vytlačiť**)
nikdy nevytvorí nové číslo. Ak tablet zopakuje tú istú požiadavku po výpadku, server vráti to isté číslo
a tlač zopakuje iba vtedy, ak predchádzajúca zlyhala.

**Obmedzenie protokolu:** ESC/POS cez TCP nemá potvrdenie „lístok bol vytlačený a odobratý“. Stav `ok`
znamená, že tlačiareň dáta prijala a po tlači nehlási chybu.

## Nastavenie tabletu krok za krokom
1. Tablet s Androidom 7.0 alebo novším (odporúčané 10\"+, Android 10+), pripojený do Wi-Fi ambulancie.
2. Spustite server (pozri hlavný návod) a overte v prehliadači tabletu `http://SERVER:8080/tablet/`.
3. Zostavte a nainštalujte APK – postup v [android/README.md](android/README.md).
4. Pri prvom spustení zadajte adresu servera, **Overiť spojenie**, zvoľte PIN správcu, **Uložiť a spustiť**.
5. Zapnite kiosk režim (odporúčané: správca zariadenia `adb shell dpm set-device-owner sk.adna.tablet/.AdminReceiver`).
6. V systémových nastaveniach tabletu: vypnite uspávanie obrazovky pri nabíjaní (aplikácia drží obrazovku
   zapnutú, kým beží), vypnite automatické aktualizácie počas ordinačných hodín, nechajte tablet na nabíjačke.
7. Skúška: stlačte „Prihlásiť sa“ → vytlačí sa lístok → číslo vidí sestra.

Skryté nastavenia: **5× ťuknúť do ľavého horného rohu** do 3 sekúnd → PIN.

## Ochrana pred chybami (zhrnutie)
* Tlačidlo reaguje na prvý dotyk a hneď sa zablokuje – opakované, viacprstové aj dlhé stlačenie vytvorí jedno číslo.
  Po návrate na úvod je ešte 0,8 s ochranná pauza.
* Každé stlačenie má jedinečný identifikátor požiadavky uložený v `sessionStorage`. Pri výpadku sa požiadavka
  automaticky zopakuje 3× (1, 2, 4 s) s **tým istým** identifikátorom; potom sa zobrazí chyba
  s tlačidlami **Skúsiť znova** (ten istý identifikátor) a **Zrušiť**. Ak sa stránka medzitým obnoví,
  nedokončená požiadavka sa dokončí – nevznikne druhé číslo.
* Pri strate spojenia so serverom sa vpravo hore zobrazí nenápadné „Bez spojenia so serverom – obnovujem…“.
* Na tablete sa nezadávajú ani nezobrazujú žiadne osobné údaje.

## Test
```bash
# server musí bežať na tom istom počítači (simulovaná tlačiareň je na 127.0.0.1)
ADNA_URL=http://127.0.0.1:8080 ADNA_PASSWORD='heslo personálu' node apps/tablet/test/e2e.js
# pri novej databáze bez hesla pridajte ADNA_SETUP_CODE=<kód zo server/data/SETUP-KOD.txt>
```
Test mení nastavenia tlače a vytvára čísla – **nespúšťajte ho na ostrej databáze.**

## Obmedzenia 1. verzie
* Len sieťové ESC/POS tlačiarne; USB/Bluetooth nie sú implementované.
* Spoľahlivosť zistenia stavu závisí od modelu tlačiarne (DLE EOT).
* Tablet nie je chránený prihlásením – registrácia je verejná v LAN a obmedzená na 60 požiadaviek za minútu z jednej IP.
* APK nebolo zostavené ani vyskúšané na fyzickom tablete v rámci vývoja (pozri android/README.md).
