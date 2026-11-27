# AdNa Prehľad – stav ambulancie na diaľku

Živý prehľad pre vedenie ambulancie v mobile (2026-11-27, Pali). **Len na čítanie** – nič nevyvoláva ani nemení.

* Web: `https://vyvolavaci.adna.sk/prehlad/` (v ambulancii aj `http://10.160.1.16:8080/prehlad/`).
* Android appka **AdNa Prehľad** (`android/`) je okno na túto stránku (WebView); APK zostavuje GitHub Actions
  (workflow „Zostavenie AdNa“ → Artifacts → `adna-prehlad-debug-apk`). Inštalácia mimo Google Play
  (povoliť „Inštalovať neznáme aplikácie“ pre prehliadač/Súbory). Adresu servera možno zmeniť na stránke pri výpadku.
* Prihlásenie rovnakým kontom ako v aplikácii Sestra (meno + heslo, server stráži platnosť prihlásenia).

Čo ukazuje:
* **Práve teraz** – koľko čaká na sestru / na lekára (s najdlhším čakaním), koľko je u sestry, u lekára, na ukončení, ukončení dnes;
* **Ambulancie** – lekár a sestra dňa, kto je práve vnútri a odkedy, rad a aktuálne meškanie oproti termínom;
* **Čakáreň** – poradové čísla, typ návštevy, termín a ako dlho čakajú;
* **Dnes spolu** (sestra, správca) a **Tento týždeň podľa lekárov** (len správca) – z tých istých výpočtov ako Štatistiky v Sestre.

Ochrana údajov: identifikátor pacienta (poznámka sestry) sa v prehľade nezobrazuje, v telefóne sa neukladajú žiadne údaje
pacientov (service worker drží len súbory aplikácie). Na diaľku len HTTPS; HTTP je v appke povolené iba pre LAN adresu servera.

Test: `node apps/prehlad/test/e2e.js` (Playwright, Chromium, telefón Pixel 7; `ADNA_SCREENSHOTS=/adresar` uloží snímky).
