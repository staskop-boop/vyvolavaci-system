# AdNa Obrazovka v čakárni (aplikácia 3)

> **Verzia 2 (TV program):** obrazovka má vľavo panel (vyvolané číslo, *Na rade* s odchýlkou od termínu – zelená skôr/načas,
> červená meškanie – a naposledy vyvolané), vpravo zónu pre TV program a dole lištu so správami z RSS. Pri vyvolaní zaznie
> signál a číslo s ambulanciou sa ukáže v paneli, cez TV zónu aj na lište. Pre Samsung TV s Antik TV pozri
> [`minipc/README.md`](minipc/README.md) (mini PC cez HDMI). Test: `node apps/tv/test/e2e-v2.js`.
> Parameter `?zona=prazdna` = čierna TV zóna pre samostatné okno prehrávača.

Samostatná aplikácia pre televízor v čakárni. Veľkým písmom zobrazuje práve vyvolané poradové číslo
a ambulanciu, do ktorej má pacient vstúpiť, zoznam naposledy vyvolaných čísel a pri každom vyvolaní
(aj zopakovanom) číslo zvýrazní a prehrá krátky zvukový signál. **Nezobrazuje žiadne osobné údaje** –
iba poradové čísla a názvy ambulancií.

## Z čoho sa skladá
| Časť | Priečinok | Úloha |
|---|---|---|
| Android TV aplikácia | `android/` | natívny obal: celá obrazovka, ovládač, nastavenie adresy servera, spúšťanie po zapnutí, obnova pri výpadku |
| Webové zobrazenie | `web/` | vzhľad a logika obrazovky; servíruje ho spoločný server na adrese `/obrazovka/` |
| Automatický test | `test/e2e.js` | overenie celého správania v prehliadači Chromium |

Webová časť sa načítava zo servera, takže zmena vzhľadu nevyžaduje preinštalovanie aplikácie v TV.
Tú istú stránku možno v núdzi otvoriť aj v bežnom prehliadači (napr. na počítači pripojenom k TV cez HDMI):
`http://ADRESA-SERVERA:8080/obrazovka/` a prepnúť na celú obrazovku (F11).

## Požiadavky
* Televízor s Android TV / Google TV alebo Android TV box, Android 6.0 alebo novší, diaľkový ovládač.
* Pripojenie do tej istej lokálnej siete ako server AdNa (odporúčame kábel; Wi-Fi funguje tiež).
* Bežiaci server AdNa (pozri hlavný návod `docs/`).
* Na zvuk: reproduktory TV zapnuté, hlasitosť nastavená vopred.

## Nastavenie krok za krokom
1. Zostavte a nainštalujte APK – postup je v [`android/README.md`](android/README.md).
2. Spustite **AdNa Obrazovka**. Pri prvom spustení zadajte adresu servera (napr. `192.168.1.10`),
   stlačte **Otestovať spojenie** a potom **Uložiť a spustiť**.
3. Zobrazí sa uvítanie „Vitajte v ambulancii – Sledujte, prosím, svoje poradové číslo.“
4. Vyskúšajte: na tablete si zoberte číslo, v aplikácii sestry ho vyvolajte. Na TV sa musí objaviť číslo,
   ambulancia a zaznieť signál.
5. Nastavte automatické spustenie po zapnutí (pozri `android/README.md`, časť 5 – nie je zaručené na každom TV).

## Ovládanie diaľkovým ovládačom
* **MENU** alebo **podržanie OK na 1,5 s** – nastavenia (adresa servera, test spojenia, spúšťanie po zapnutí).
* **Späť** – prvé stlačenie iba upozorní, druhé do 2 sekúnd aplikáciu ukončí.
* Aplikácia nevyžaduje dotyk ani myš.

## Zvuk
* V Android aplikácii je automatické prehrávanie povolené, signál zaznie bez ďalšieho nastavovania.
* V bežnom prehliadači môže byť zvuk zablokovaný, kým sa na stránke niečo nestlačí. Vtedy sa zobrazí okno
  **„Zvuk je zablokovaný prehliadačom“** s tlačidlom **Zapnúť zvuk** – stačí raz stlačiť **OK** na ovládači
  (alebo kliknúť). Kým zvuk nie je aktívny, v pravom dolnom rohu svieti upozornenie **„Zvuk nie je aktívny“**.
  Po obnovení stránky v prehliadači treba zvuk aktivovať znova.
* Zvuk sa dá vypnúť v administrácii (aplikácia sestry → Nastavenia → Zvuk). Vtedy sa výzva ani upozornenie nezobrazuje.
* Signál je „marimba“ – tri krátke mäkké údery (~1,3 s), vytvorený priamo v prehliadači – nepotrebuje zvukové súbory.

## Čo sa zobrazuje
* **Nikto ešte nebol vyvolaný:** uvítanie a pokyn sledovať pridelené číslo.
* **Vyvolanie:** veľké číslo (napr. *A012*) a text „Prosíme, vstúpte do: *Ambulancia č. 1*“, zvýraznenie a zvuk.
* **Zopakované vyvolanie:** rovnaké číslo sa znovu zvýrazní a zaznie signál.
* **Naposledy vyvolané:** niekoľko predchádzajúcich čísel s ambulanciou (počet sa nastavuje v administrácii).
* **Omylom vyvolané číslo:** keď ho sestra vráti medzi čakajúcich, z obrazovky zmizne.
* **Nový deň / ukončenie dňa:** obrazovka sa vráti na uvítanie.

## Riešenie problémov
| Príznak | Riešenie |
|---|---|
| „Obrazovka AdNa sa pripája k serveru…“ | Skontrolujte, či server beží a či je TV v rovnakej sieti. V nastaveniach overte adresu a stlačte *Otestovať spojenie*. Pokus sa opakuje automaticky každých 5 s. |
| Dole svieti „Spojenie so serverom sa obnovuje…“ | Krátky výpadok siete alebo reštart servera. Obrazovka ukazuje posledný známy stav a po obnovení sa sama aktualizuje. |
| Nezaznie zvuk | Hlasitosť / stlmenie na TV; v prehliadači stlačte OK (Zapnúť zvuk); v administrácii skontrolujte, že zvuk je zapnutý. |
| Po zapnutí TV sa aplikácia nespustí | Na niektorých TV to systém nedovolí – pozri `android/README.md`, časť 5. Aplikáciu spustite ručne. |
| TV po čase zhasne | Vypnite v TV šetrič obrazovky, Ambient mode a časovač automatického vypnutia. |
| Okraje obrazu sú orezané | Stránka má bezpečné okraje (~5 %). Ak je orezanie väčšie, v TV nastavte formát obrazu „Prispôsobiť obrazovke / Just scan“. |

## Overenie
Automatický test (Chromium, 1920×1080 a 1280×720) spustíte z koreňa projektu:
```bash
node apps/tv/test/e2e.js                      # spustí vlastný dočasný server, testuje aj výpadok
ADNA_URL=http://192.168.1.10:8080 ADNA_PASSWORD=... node apps/tv/test/e2e.js   # proti bežiacemu serveru
```
Overuje: uvítanie, vyvolanie (číslo, ambulancia, zvýraznenie, spustenie signálu), zopakovanie, zoznam
predchádzajúcich čísel, že sa nezobrazí poznámka personálu, odstránenie omylom vyvolaného čísla, obnovenie
stránky, výpadok a obnovenie servera, zablokovaný zvuk a jeho zapnutie klávesom Enter (OK), vypnutý zvuk.

Test v prehliadači overuje, že sa signál **spustil** (Web Audio); skutočné počutie zvuku, správanie konkrétneho
televízora, diaľkového ovládača, automatického spustenia a samotnej Android aplikácie treba overiť na fyzickom zariadení.

## Obmedzenia prvej verzie
* APK sa musí zostaviť v Android Studiu / Gradle (v dodanom balíku nie je predzostavený súbor).
* Spúšťanie po zapnutí závisí od výrobcu a verzie Androidu.
* Hlasový oznam čísla (syntéza reči) nie je súčasťou v1 – iba zvukový signál.
* Komunikácia so serverom je v lokálnej sieti cez HTTP; pre prevádzku cez internet pozri odporúčania v `docs/`.
