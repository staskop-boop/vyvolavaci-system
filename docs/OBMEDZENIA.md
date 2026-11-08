# Obmedzenia prvej verzie a odporúčania

## Obmedzenia v1
* **APK súbory nie sú priložené** – treba ich zostaviť v Android Studiu alebo cez GitHub Actions (pozri INSTALACIA.md).
  Android časti neboli spustené na skutočnom zariadení.
* **Tlač iba na sieťovú ESC/POS tlačiareň (TCP 9100)**. USB ani Bluetooth tlačiarne pripojené k tabletu
  v1 nie sú implementované. Žiadny konkrétny model tlačiarne nebol overený.
* Zistenie stavu tlače (DLE EOT) závisí od modelu; ak tlačiareň neodpovedá, systém tlač označí ako
  **neoverenú**, nikdy netvrdí, že prebehla. Ani stav „ok“ nezaručuje, že si pacient lístok vzal.
* Jedno spoločné konto personálu (`personal`, rola admin). Samostatné účty a oprávnenia sú pripravené v databáze, nie v rozhraní.
* Jeden spoločný zoznam čakajúcich pre všetky ambulancie; cieľová ambulancia sa volí pri vyvolaní.
* Jedna predpona čísel (predvolene „A“); viac radov (napr. B pre odbery) nie je.
* Tablet a obrazovka nemajú prihlásenie – určené iba pre lokálnu sieť.
* Hlasové hlásenie (syntéza reči) nie je, iba zvukový signál.
* Sestra beží v Microsoft Edge v režime aplikácie; plnohodnotná inštalácia PWA vyžaduje HTTPS.
* Automatické spustenie po zapnutí na Android TV / tablete nie je zaručené na každom zariadení (obmedzenia Androidu 10+ a výrobcov).
* Server je jeden bod zlyhania – pri jeho výpadku nefunguje registrácia (tablet to zrozumiteľne oznámi).

## Odporúčania pre reálnu prevádzku
1. Server na spoľahlivom PC s UPS, pevnou IP a automatickým spustením (skript `Registrovat-ulohu-Windows.ps1`).
2. Denná záloha `npm run zaloha` mimo počítača servera.
3. Tlačiareň s pevnou IP, s podporou ESC/POS a DLE EOT (bežné u tlačiarní kompatibilných s Epson TM-T20/T88 – overte v manuáli).
   Pred nákupom vyskúšajte „Overiť tlačiareň“ a kódovú stránku CP852.
4. Tablet a TV box nastaviť ako „device owner“ / predvolený launcher pre spoľahlivý kiosk a autoštart.
5. Oddeliť sieť zariadení od Wi-Fi pre pacientov.
6. Pred prevádzkou cez internet doplniť body z [INTERNET-A-BEZPECNOST.md](INTERNET-A-BEZPECNOST.md).
7. Vykonať [AKCEPTACNY-TEST.md](AKCEPTACNY-TEST.md) a doplniť oficiálne logo a farby ([DIZAJN.md](DIZAJN.md)).
