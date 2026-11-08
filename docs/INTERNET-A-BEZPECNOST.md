# Bezpečnosť a prevádzka cez internet

## Prevádzka v lokálnej sieti (v1 – odporúčané)

Systém je navrhnutý na prevádzku **iba v lokálnej sieti ambulancie**. Internet nie je potrebný:
pri výpadku internetu systém funguje ďalej, pokiaľ beží lokálna sieť a server.

Čo je zabezpečené už vo v1:
* heslá sú uložené ako scrypt hash so soľou, v zdrojovom kóde nie sú žiadne prihlasovacie údaje,
  prvé heslo sa nastavuje jednorazovým inštalačným kódom;
* prihlásenie sestry je HttpOnly cookie `SameSite=Strict`; v DB je uložený iba hash tokenu;
  relácia vyprší po 12 h nečinnosti; zmena hesla odhlási ostatné zariadenia;
* obmedzenie pokusov o prihlásenie (5 chýb → 60 s pauza) a rýchlostný limit registrácií z tabletu;
* zapisujúce volania vyžadujú JSON (ochrana proti CSRF spolu so SameSite cookie);
* verejné rozhrania (tablet, obrazovka) neprenášajú žiadne osobné údaje ani poznámky personálu;
* log `server/data/logs/server.log` neobsahuje heslá, tokeny ani obsah požiadaviek.

Odporúčania pre LAN:
* server s pevnou IP adresou; port 8080 povoliť vo firewalle iba pre súkromnú sieť;
* Wi-Fi pre zariadenia oddeliť od verejnej Wi-Fi pre pacientov (iná SSID/VLAN);
* pravidelná záloha (`npm run zaloha`, napr. denne cez Plánovač úloh);
* UPS pre server a sieťový prvok.

## Čo treba doplniť pred prevádzkou cez internet

Server **nevystavujte priamo do internetu**. Ak je potrebný vzdialený prístup:
1. **HTTPS** – reverzná proxy (napr. Caddy, nginx, IIS) s platným certifikátom; na serveri nastaviť
   `ADNA_SECURE_COOKIE=1`, server počúvať len na `127.0.0.1` (`ADNA_HOST=127.0.0.1`).
2. **Ochrana verejných rozhraní** – v1 tablet a obrazovka nepoužívajú prihlásenie. Pre internet treba
   doplniť párovanie zariadení (kľúč zariadenia pre `/api/kiosk/*` a `/ws?channel=display`), inak by ktokoľvek
   mohol vytvárať čísla.
3. **Radšej VPN** (WireGuard/IPsec) než verejné vystavenie – zariadenia aj vzdialení používatelia sa pripájajú
   do siete ambulancie.
4. **Samostatné účty** pre každú sestru (príprava je v tabuľke `users` a rolách), audit podľa používateľa,
   politika hesiel, prípadne dvojfaktorové overenie.
5. Pravidelné aktualizácie Node.js a závislostí (`npm audit`), monitorovanie dostupnosti, zálohy mimo budovy.
6. Posúdenie z hľadiska GDPR / internej bezpečnostnej politiky (v1 nespracúva osobné údaje pacientov,
   pri doplnení mien by sa to zmenilo).
