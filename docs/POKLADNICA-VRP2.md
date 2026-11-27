# Platba pacienta a pokladničný doklad VRP2

Pri platenej návšteve sestra vo formulári **Ukončiť pacienta** vyberie hradené výkony a spôsob úhrady, potvrdí prijatie
platby a klikne na **Ukončiť pacienta a vytlačiť doklad**. Server ukončí návštevu a založí úlohu. Lokálny agent na počítači
recepcie zadá doklad do VRP2 Finančnej správy SR, pred vystavením ho porovná s potvrdenou platbou, vystaví ho a pošle
originálny výstup z VRP2 na tlačiareň recepcie. Výsledok sa ukáže pri návšteve a ostane v histórii.

```
Sestra (prehliadač) ──► server AdNa ◄── lokálny agent (PC recepcie) ──► VRP2 Finančnej správy
   formulár, stav         platby, úlohy        Playwright + tlač            (alebo SIMULÁTOR)
                                                      └──► tlačiareň recepcie
```

## 1. Čo je overené a čo nie (stav k 27. 11. 2026)

| Časť | Stav |
|---|---|
| Formulár, výpočet súm, atómové ukončenie + platba + úloha, ochrana pred duplicitou, stavy, zoznam „Doklady na doriešenie“, nastavenia, oprávnenia | **Overené automatickými testmi** (server + prehliadač) |
| Agent: preberanie úloh, kontrola pokladnice, porovnanie pred vystavením, denník, správanie po páde, tlač, kópia | **Overené so SIMULÁTOROM VRP2** |
| Ovládanie skutočnej VRP2 (`agent/src/drivers/vrp2-web.js`) | **NEOVERENÉ** – pri vývoji nebol prístup do VRP2. Ovládač je pripravený, ale bez selektorov; v ostrom režime nič nevystaví, kým poverená osoba nevyplní a neoverí `vrp2-ovladanie.json` (časť 7) |
| Fyzická tlač | **NEVYTLAČENÉ** – tlač je overená len do súboru. Tichá tlač cez SumatraPDF na tlačiareň recepcie sa musí vyskúšať na mieste („Skúšobná tlač“) |
| Doklad v ostrej VRP2 | **Žiadny nebol vystavený.** Testy bežia výlučne proti simulátoru |

**Nasadenie tejto verzie nič nezapne:** voľba „Platba pacienta“ je vypnutá, nové pokladnice sú v skúšobnom režime a ostrý
režim treba zapnúť na troch miestach (pokladnica v Nastaveniach, `rezim` + `ostryRezimPovoleny` v konfigurácii agenta,
`overene: true` v ovládaní VRP2).

## 2. Čo hovoria oficiálne zdroje o VRP2

Zdroje: [VRP 2 na portáli FS](https://www.financnasprava.sk/sk/podnikatelia/dane/ekasa/vrp2),
[príručka VRP2 (2022)](https://www.financnasprava.sk/_img/pfsedit/Dokumenty_PFS/Elektronicke_sluzby/Elektronicka_komunikacia/Elektronicka_komunikacia_dane/Prirucky_navody/2022/2022.06.30_VRP2_prirucka.pdf),
[nastavenia tlače VRP2 (2023)](https://www.financnasprava.sk/_img/pfsedit/Dokumenty_PFS/Elektronicke_sluzby/Elektronicka_komunikacia/Elektronicka_komunikacia_dane/Prirucky_navody/2023/2023.06.26_VRP2_print.pdf),
[zákon č. 384/2025 Z. z. o evidencii tržieb](https://static.slov-lex.sk/static/SK/ZZ/2025/384/20260101.html).
Novšiu príručku z 20. 8. 2025, na ktorú portál odkazuje, treba pred ostrým spustením prečítať – tu z nej nečerpáme.

* **Rozhranie (API) pre iné systémy FS pre VRP2 neuvádza.** Zákon 384/2025 (§ 2) hovorí, že virtuálna pokladnica sa
  poskytuje prostredníctvom mobilných aplikácií a klientskeho prostredia na webe Finančnej správy. Jediná cesta, ako doklad
  vystaviť bez ručnej práce sestry, je preto ovládanie oficiálneho webu `https://vrp2.financnasprava.sk/` prehliadačom.
* **Prípustnosť automatizácie:** v prečítaných dokumentoch sme nenašli zákaz, ale ani súhlas. **Pred ostrým spustením si
  vyžiadajte písomné stanovisko Finančnej správy** (alebo daňového poradcu), či smie doklady v klientskom prostredí VRP2
  zadávať program v mene prihláseného používateľa. Ak nie, riešením je certifikovaná online registračná pokladnica (eKasa)
  s integračným rozhraním – agent je na výmenu ovládača pripravený (rovnaké rozhranie ako simulátor).
* **Prihlásenie:** meno a heslo (prvé prihlásenie aj PIN). **Po 20 minútach nečinnosti VRP2 spustí 5-minútový odpočet
  a odhlási.** Agent prihlásenie neobchádza, heslo neukladá a reláciu umelo neudržiava. Dôsledok: po dlhšej prestávke bez
  dokladu ukáže aplikácia „treba obnoviť prihlásenie do VRP2“ a poverená osoba sa na PC recepcie prihlási znova. Platby sa
  medzitým prijímajú ďalej, doklady sa vystavia po prihlásení. Toto je **hlavná známa prekážka** úplne bezobslužnej
  prevádzky.
* **Tlač:** webová VRP2 vytvorí doklad ako PDF (A4, A5, A6, 58 mm, 80 mm), otvorí ho v novej karte a zavolá tlač
  prehliadača. Agent PDF prevezme a pošle ho na tlačiareň potichu. VRP2 podporuje tlač kópie dokladu.
* **Zaokrúhľovanie hotovosti** na 5 centov platí od 1. 7. 2022 (novela zákona o cenách) a podľa portálu FS ho VRP2 robí sama;
  karta sa nezaokrúhľuje. Presnú tabuľku sme v zdrojoch FS neoverili – výpočet je v `shared/peniaze.js`. Poistka: agent
  porovná zaokrúhlenie a sumu na úhradu s VRP2 a pri rozdiele doklad nevystaví.
* **Spárovanie dokladu po výpadku:** VRP2 má zoznam vystavených dokladov, ale nepoznáme pole, ktorým by sa dal doklad
  jednoznačne priradiť k našej platbe. Rovnaká suma a čas nestačia, preto ostrý ovládač po výpadku nikdy nehádá a úlohu
  odovzdá poverenej osobe.

## 3. Návod pre sestru

1. Pri pacientovi kliknite na **✓ Ukončený**. Otvorí sa formulár *Ukončiť pacienta*.
2. **Bez priamej úhrady** → *Ukončiť pacienta* (ako doteraz).
3. **Platba pacienta**:
   * ak recepcia účtuje za obe spoločnosti, vyberte spoločnosť – jej názov je potom veľkým písmom v čiernom pruhu,
   * zaškrtnite výkony, ktoré pacient hradí; pri výkone s končatinami vyberte *jedna* / *obe*, prípadne upravte množstvo,
   * skontrolujte **Celkovú sumu**,
   * **Hotovosť:** napíšte prijatú sumu, systém ukáže zaokrúhlenie a výdavok; zaškrtnite, že ste hotovosť prijali,
   * **Karta:** zadajte sumu na termináli; až keď terminál platbu schváli, zaškrtnite *Terminál platbu schválil*.
     Pri zamietnutí kliknite *Terminál platbu zamietol* – nič sa nezaeviduje a môžete zvoliť hotovosť,
   * kliknite **Ukončiť pacienta a vytlačiť doklad**. Doklad vyjde z tlačiarne recepcie; VRP2 neotvárate.
4. Stav vidíte pri pacientovi v zozname *Ukončení a neprítomní*:

| Text | Čo to znamená | Čo urobiť |
|---|---|---|
| Platba prijatá · pripravuje sa doklad. | agent pracuje | počkať |
| Platba prijatá · čaká na agenta. | PC recepcie alebo agent nebeží | zapnúť PC recepcie, inak správca |
| Platba prijatá · treba obnoviť prihlásenie do VRP2. | VRP2 odhlásila | zavolať poverenú osobu |
| Platba prijatá · vydanie dokladu treba overiť. | nie je isté, či VRP2 doklad vydala | správca – **neopakujte platbu** |
| Doklad vydaný · odoslané na tlačiareň. | hotovo | podať doklad pacientovi |
| Doklad vydaný · chyba tlače. | papier, tlačiareň | odstrániť príčinu, **Zopakovať tlač** |

Čo treba doriešiť, je aj v zozname **Doklady na doriešenie**. Pacient v ňom vždy *už zaplatil* – platbu nikdy neprijímajte
druhýkrát. „Zopakovať tlač“ tlačí kópiu toho istého dokladu, nový doklad nevznikne.
Text **SIMULÁCIA** znamená skúšobný režim: výtlačok nie je pokladničný doklad.

## 4. Návod pre správcu – nastavenie (Sestra → Nastavenia → Platby pacientov a pokladnice VRP2)

1. **Spoločnosti:** doplňte IČO AdNa s.r.o. a Ultrazvukové pracovisko s.r.o.
2. **Agent:** *Pridať agenta* (napr. „Recepcia 1“). Token sa ukáže iba raz – vložte ho do konfigurácie na PC recepcie.
3. **Pokladnica:** pre každú spoločnosť jedna. Vyplňte kód pokladnice VRP2 (je v exporte VRP2, hárok *Filtrovacie kritériá*),
   agenta, názov tlačiarne presne ako vo Windows a pracoviská, ktoré ju používajú.
4. **Cenník:** vo VRP2 exportujte *Tovary a služby* (xlsx), označte riadky, Ctrl+C a vložte do poľa *Import*. Názvy musia byť
   znak po znaku ako vo VRP2 – agent podľa nich položku hľadá. Položky bez ceny (napr. „Ag test - Covid 19“) sa nedajú účtovať,
   kým cenu nedoplníte. Skúšobné položky („pokus“) vypnite.
5. **Výkony:** *Pridať bežné výkony* a každému priraďte položku; pri EVLA, TEVLA a pod. samostatne *jedna* / *obe končatiny*.
   Pri výkone účtovanom po kusoch (CLaCS – 1 impulz) nastavte predvolené množstvo.
6. **Skúšobná tlač** – vytlačí stránku „SKÚŠOBNÁ TLAČ – NIE JE TO POKLADNIČNÝ DOKLAD“, bez VRP2 a bez tržby.
7. Zaškrtnite **Zapnúť voľbu „Platba pacienta“** a vyskúšajte celý priebeh v skúšobnom režime.

Neskoršia zmena cenníka ani pokladnice nemení už potvrdené platby – každá má vlastnú nemennú kópiu.

## 5. Inštalácia agenta na PC recepcie (Windows)

Potrebné: Node.js ≥ 22.13, repozitár (napr. `C:\AdNa`), [SumatraPDF](https://www.sumatrapdfreader.org/) na tichú tlač.

```powershell
cd C:\AdNa\agent\windows
.\Instalovat-agenta.ps1                 # pre ostrý režim neskôr: .\Instalovat-agenta.ps1 -SProhliadacom
notepad $env:ProgramData\AdNa\vrp2-agent\konfiguracia.json     # server, token, tlačiareň
cd ..; node src\index.js kontrola       # spojenie, relácia, aktívna pokladnica, tlačiareň
Start-ScheduledTask -TaskName "AdNa VRP2 agent"
```

Agent sa spúšťa sám po prihlásení používateľa do Windows a po páde sa reštartuje. Nepotrebuje otvorenú aplikáciu Sestra.
Jeden token = jeden bežiaci agent; ten istý token nedávajte na dva počítače.
Konfigurácia, denník, profil prehliadača a logy sú v `%ProgramData%\AdNa\vrp2-agent` (prístup len pre používateľa recepcie
a správcov). Do repozitára ani do logov sa nedostane heslo, token, cookies ani údaje karty. Agent zo servera dostáva iba
interné číslo platby, pokladnicu, položky, sumy a platidlo – žiadne meno, rodné číslo ani číslo z poradia.

**Výber tlačiarne:** názov v Nastaveniach (stĺpec *Tlačiareň*) musí sedieť s názvom vo Windows
(`Get-Printer | Select Name`). Šírku papiera (58 / 80 mm) nastavte rovnako vo VRP2 (Nastavenia tlače) aj v ovládači tlačiarne.
Stav **vytlačené** sa ukáže len vtedy, keď ho tlačové rozhranie potvrdí; Windows potvrdí iba prijatie do frontu, preto
bežne uvidíte „odoslané na tlačiareň“.

## 6. Obnova po výpadku

| Situácia | Čo sa stane | Čo urobiť |
|---|---|---|
| Agent / PC recepcie nebeží | platby sa prijímajú, doklady čakajú | zapnúť PC, prihlásiť sa do Windows |
| VRP2 odhlásila | „treba obnoviť prihlásenie“ | `node src\index.js prihlasenie`, prihlásiť sa, **skontrolovať pokladnicu**, okno zavrieť |
| Vo VRP2 je aktívna iná pokladnica / chýba položka / iná cena | agent zastaví pred vystavením a napíše konkrétny rozdiel | opraviť vo VRP2 alebo v cenníku → *Vyriešiť… → skúsiť znova* |
| Výpadok počas vystavenia | „vydanie dokladu treba overiť“, nič sa neopakuje samo | vo VRP2 otvoriť *Zoznam vystavených dokladov*, nájsť doklad podľa položiek, sumy a času → *Vyriešiť…*: **Doklad je vo VRP2** (opísať ID) alebo **Doklad vo VRP2 nie je** (napísať NEVYDANÝ – až potom vznikne nový pokus) |
| Chyba tlače | doklad je vydaný, návšteva ukončená | odstrániť príčinu → *Zopakovať tlač* |

Po páde agent z vlastného denníka rozlíši úlohu, pri ktorej ešte neklikol na vystavenie, od úlohy, pri ktorej VRP2 mohla doklad
vydať. Server navyše databázovým pravidlom nedovolí vrátiť do fronty úlohu, pri ktorej sa odoslanie začalo.
Kto platbu potvrdil, kto a ako riešil chybu a každú zmenu stavu nájdete v *História* a v okne *Vyriešiť… → Priebeh*.

## 7. Overenie ostrej VRP2 (poverená osoba + vývojár, raz pred spustením)

1. Písomné stanovisko k automatizácii (časť 2).
2. `.\Instalovat-agenta.ps1 -SProhliadacom`, potom `node src\index.js prihlasenie` – **prvé prihlásenie** robí poverená osoba
   v otvorenom okne (meno, heslo, PIN). Prihlásenie ostane len v profile prehliadača na tomto PC.
3. **Kontrola správnej pokladnice:** v okne VRP2 overte kód pokladnice a spoločnosť; musia sedieť s Nastaveniami.
4. Do `%ProgramData%\AdNa\vrp2-agent\vrp2-ovladanie.json` doplňte selektory prvkov VRP2 (vzor: `agent/vrp2-ovladanie.vzor.json`).
   Vypĺňajú sa podľa skutočnej stránky – v repozitári zámerne nie sú žiadne odhadnuté.
5. Vo VRP2 si založte položku za 0,01 € (v exporte už je „pokus“) a v pracovnom čase s vedomím účtovníčky vystavte **jeden**
   skúšobný doklad cez aplikáciu Sestra. Skontrolujte položky, sumu, platidlo, ID dokladu, QR kód na výtlačku a kópiu.
   Je to skutočná tržba 0,01 € – zaúčtujte ju alebo stornujte podľa pokynov účtovníčky.
6. Až potom nastavte `"overene": true`, `"rezim": "live"`, `"ostryRezimPovoleny": true` a v Nastaveniach *Zapnúť ostrý režim…*.

## 8. Testy

```
cd server && npm test                    # vrátane test/platba-vrp2.test.js – scenáre 1 – 9 so simulátorom
cd agent && npm test                     # porovnanie, denník, PDF, poistky ostrého režimu
node apps/sestra/test/e2e-platba.js      # scenár 10: celý priebeh v prehliadači, skutočný proces agenta, simulátor
```
