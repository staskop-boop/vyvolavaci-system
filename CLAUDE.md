# Poznámky pre vývoj (Claude Code)

* Jazyk projektu je slovenčina – texty v UI, dokumentácia, commity aj komentáre píšeme po slovensky.
* Server: Node.js ≥ 22.13, Express + ws, databáza vstavaný `node:sqlite` (bez natívnych modulov). Webové časti
  (`apps/*/web`, `shared/`) sú čisté HTML/CSS/JS bez zostavovania – server ich slúži priamo.
* Pred commitom spustiť `cd server && npm test`. Zmeny UI overiť e2e testom príslušnej aplikácie (Playwright).
* Farby a písmo AdNa sú v `shared/adna-theme.css` a `docs/dizajn-v3/` (červená #c8102e, čierna #111, biela);
  chybové hlásenia vždy s ⚠ a textom, nikdy len farbou.
* Systém je anonymný – nepridávať mená pacientov ani iné osobné údaje bez výslovného rozhodnutia (GDPR).
* `server/data/` (databáza, logy, inštalačný kód) nikdy necommitovať.
* Cieľové nasadenie: mini PC pri Samsung TV (server + Edge na celú obrazovku), doména vyvolavaci.adna.sk cez
  Cloudflare Tunnel – pozri `docs/NASADENIE.md`.
