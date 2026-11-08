# Dizajn a logo

Použité sú **farby AdNa: červená, čierna a biela** – biele pozadie, červená `#c8102e` (hlavné tlačidlá,
vyvolané číslo, „Na“ v názve), čierna `#111111` (texty, názov ambulancie, stav „Vyvolaný“), karty so
zaoblenými rohmi, veľké písmo. Presné odtiene z dizajn manuálu doplňte v `shared/adna-theme.css`.
Oficiálne logo nebolo k dispozícii a nevymýšľalo sa – zobrazuje sa iba textový názov „AdNa“.

**Aby červená nebola mätúca:** červená je farba značky, nie signál chyby. Chyby a upozornenia preto
nikdy nie sú vyjadrené len farbou – majú vždy ikonu ⚠, text a zvýraznený ľavý okraj (tmavočervená
`#8b1a1a` pre chyby, jantárová pre neoverenú tlač). Stav „Vyvolaný“ je čierny štítok s ▶,
„Čaká“ biely štítok s rámčekom. Lístok sa tlačí čiernobielo (termálna tlač), farby sa ho netýkajú.

## Ako doplniť oficiálne farby a logo
1. Farby zmeňte na jednom mieste: `shared/adna-theme.css` (premenné `--adna-…`). Platí pre všetky tri aplikácie.
2. Logo uložte ako `shared/logo.svg` (alebo `.png`). V súboroch `apps/*/web/index.html` nahraďte prvok
   s triedou `adna-wordmark` značkou `<img src="/shared/logo.svg" alt="AdNa" class="adna-logo">`.
3. Ikony Android aplikácií: `apps/tablet/android/app/src/main/res/drawable*` a `apps/tv/android/app/src/main/res/drawable*`
   (v Android Studiu: *File → New → Image Asset*).
4. Na lístku je názov kliniky textom (nastavenie „Názov“ v administrácii); tlač loga na lístok v1 nie je.
