# AdNa – vyvolávací systém pre čakáreň (Samsung TV)

Dizajnový podklad pre implementáciu v Claude Code. Komunikuj po slovensky.
Aplikácia beží na Samsung Smart TV (Tizen, web app) v rozlíšení **1920 × 1080**,
na celej obrazovke, 24/7. Vľavo čísla a pokyny pre pacientov, v najväčšom okne
TV Antik, dole lišta správ, v hlavičke logo, hodiny, dátum a počasie.

## Obsah balíka

| Cesta | Čo to je |
|---|---|
| `prototype/index.html` | Funkčný HTML prototyp hlavnej obrazovky (pokojový stav) – 1 : 1 s dizajnom, živé hodiny, bežiaci ticker. Otvor v prehliadači. |
| `prototype/vyvolanie.html` | Stav „vyvolanie pacienta" (zvýraznená karta, pulz, banner cez TV okno). |
| `prototype/vianoce.html` | Sezónna téma Vianoce – padajúce vločky, svetielka, pozdrav (vzor pre ostatné témy). |
| `data/meniny-sk.json` | Slovenský kalendár menín (`MM-DD` → meno). |
| `prototype/assets/adna-logo.png` | Oficiálne logo AdNa, PNG s priehľadným pozadím (1800 × 1702). **Vždy používaj toto logo, nikdy ho neprekresľuj.** |
| `assets/adna-logo.png` | To isté logo pre produkčný build. |
| `tokens.css` | Dizajnové tokeny ako CSS premenné. |
| `design/*.dc.html`, `design/canvas.json` | Zdroj z dizajnového plátna (Claude Design) – referencia, nie na priame použitie. |

## 1. Vizuálna identita

- **Značka:** AdNa s.r.o., Ambulancia cievnej chirurgie, Krivá 17, Košice. Web mamkrcovezily.sk.
- **Farby:** červená a jej odtiene, biela, čierna; sivá #434242 je druhá farba loga.
  - `--adna-red #BC1A21` primárna (Ambulancia 1, akcenty, hodiny, lišta „Správy")
  - `--adna-red-dark #8E1219` tmavší odtieň (tiene, horný okraj vĺn)
  - `--adna-red-light #D62B33`, `--adna-rose #F0A5A8` – prechod vĺn
  - `--adna-blush #FFF4F4` + okraj `#F3C9CB` – pozadie chipov (počasie)
  - `--adna-grey #434242` (Ambulancia 2, sekundárny text), `--adna-black #1A1A1A` (text, tmavé karty, ticker), `--adna-white #FFFFFF`
- **Písma** (prevzaté z webu mamkrcovezily.sk): **Plus Jakarta Sans** 800 na nadpisy, čísla a hodiny; **Inter** 400–700 na text. Na TV písma **zabaľ lokálne** (woff2 v `/fonts`), nespoliehaj sa na Google Fonts – TV nemusí mať internet pri štarte. Čísla s `font-variant-numeric: tabular-nums`.
- **Pozadie – „vlny" (pôvodný návrh Matyáša Brycha, `krcove_web_background.png`):** zvislý prechod `#A3151B → #C9242B (16 %) → #F0A5A8 (34 %) → #FFFFFF (50 %)`, cez ktorý idú dve biele hodvábne vlny (alfa 0,55 a 0,75, horizontálny prechod priehľadnosti) a dve tenké biele linky (2 px / 1,5 px). Dole jemná svetloružová vlna. Presné SVG cesty sú v `prototype/index.html` (prvý `<svg>` v `.stage`). Pozadie je statické – nikdy ho neanimuj (šetrí GPU TV a nepúta pozornosť).
- **Okná (karty):** biele, `border-radius: 28px`, 2 px biely rám, vnútorná červená linka `inset 0 0 0 1px rgba(188,26,33,.16)`, tieň `0 24px 60px rgba(110,14,20,.18)`. Tmavá varianta `#1A1A1A` s červenou žiarou v pravom hornom rohu (`radial-gradient … rgba(188,26,33,.45)`). TV okno má čierny podklad `#0B0B0C` a rám s červenou linkou 35 % alfa.
- **Štýl:** moderný, dynamický, profesionálny; pilulkové štítky (`border-radius: 999px`), žiadne emoji, ikony len ako inline stroke SVG (2,2–2,6 px).

## 2. Rozloženie 1920 × 1080 (všetko v px)

```
┌ 48 px okraj ─────────────────────────────────────────────────────────┐
│ HLAVIČKA  y 36–148 (výška 112) – grid: auto | 1fr | auto              │
│  logo 80 px | oddeľovač | názov + podtitul ‖ POČASIE (stred, panel:   │
│  ikona 56 px + teplota 34 px + popis | predpoveď 3 dni) ‖ hodiny 54 px │
├ 28 px medzera ───────────────────────────────────────────────────────┤
│ TELO  grid: 560 px | 32 px | zvyšok (1232 px)      y 176 – ~936      │
│  ┌ Práve vyšetrujeme ┐   ┌ TV ANTIK (16 : 9, čierny rám) ───────────┐ │
│  │ A 24 Amb. 1        │   │                                           │ │
│  │ B 11 Amb. 2        │   │                                           │ │
│  ├ Nasledujú (5 chipov)┤  │                                           │ │
│  ├ Informácie (tmavá) ┤   ├ lišta kanála: LIVE · TV Antik · zvuk ─────┤ │
├ 24 px medzera ───────────────────────────────────────────────────────┤
│ LIŠTA SPRÁV  výška 84, y 960–1044: [SPRÁVY] ticker … [Zdroj · čas]   │
└ 36 px spodný okraj ──────────────────────────────────────────────────┘
```

Ľavý stĺpec: medzery 16 px; karta „Práve vyšetrujeme" má pre každú ambulanciu riadok 196 px dlaždica (výška 104, číslo 76 px) + názov 27 px, lekár 16 px, „Dvere č. X" 16 px červeným so šípkou. „Nasledujú": chipy 24 px, 2 px rám (A = červený, B = sivý), max. 5 v jednom rade. „Nasledujú": jeden riadok – vľavo nadpis 17 px + „čakanie 12 min", vpravo 5 chipov 20 px. „Informácie pre pacientov": tmavá karta, 4 odrážky 16 px s ikonou, vyplní zvyšok výšky (`flex: 1`), obsah sa nikdy nesmie prelievať pod lištu (`overflow: hidden`). Znenie odrážok (editovateľné v admin paneli):
1. Pripravte si **kartičku poistenca** a výmenný lístok od svojho lekára.
2. Po vyvolaní čísla vstúpte do ambulancie do **2 minút**, inak bude číslo zaradené na koniec poradia.
3. Objednaní pacienti majú **prednosť** v čase svojho termínu. Ďakujeme za trpezlivosť.
4. Čas objednania je **orientačný** – je to čas, kedy idete k sestre na prvotné vyšetrenie. Poradie sa prispôsobuje priebehu ambulancie počas dňa.

## 3. Stavy obrazovky

1. **Pokojový stav** (`prototype/index.html`) – TV hrá so zvukom, čísla statické, bodka „live" pri nadpise pulzuje (opacity), ticker beží zľava doprava 48 s na cyklus (CSS `translateX(-50%)`, obsah zdvojený).
2. **Vyvolanie** (`prototype/vyvolanie.html`) – po novom čísle z backendu:
   - karta ambulancie sa prefarbí na červenú, číslo 136 px na bielej dlaždici **pulzuje** (`scale 1 → 1.03`, 1,4 s), dole beží 8 s časový pruh;
   - **vedľa čísla sa namiesto šípky zobrazí lekár** (rám 200 × 196 px, zaoblený 22 px, biely 3 px okraj): dnes oživená fotka z webu (Ken‑Burns + animované gesto ruka → šípka smerom k dverám), neskôr 4‑sekundová video slučka, v ktorej lekár kývne „poďte ďalej“ a **ukáže rukou smer k dverám svojej ambulancie**; pod rámom popis „Poďte ďalej · MUDr. Staško · dvere č. 1 vpravo“. V banneri nad TV oknom je okrúhla fotka lekára (72 px).
   - *Výroba klipov:* pre každého lekára natočiť 2 verzie (ukazuje vľavo / vpravo) na jednofarebnom pozadí, 1080 × 1080 alebo 9 : 16, bez zvuku, export WebM (VP9, ideálne s alfa kanálom) + MP4 fallback, ≤ 3 MB; alternatívne animovať fotku lekára AI nástrojom (napr. Runway / HeyGen Avatar) – výsledok musí byť prirodzený, inak použiť natočený klip. Súbory `assets/doctors/<id>-left.webm`, `<id>-right.webm`; smer sa vyberá podľa `door.side` v konfigurácii ambulancie. Ak video chýba, zobrazí sa statická fotka lekára s animovanou šípkou (fallback).
   - cez horný okraj TV okna sa vysunie biely banner „Pacient s číslom A 25, prosíme, vstúpte · Ambulancia 1 · Dvere č. 1";
   - prehrá sa gong (krátky, ≤ 1 s) a **hlasové oznámenie** (TTS alebo nahrané mp3: „Číslo A dvadsaťpäť, ambulancia jedna"); TV Antik sa počas 8 s **stlmí**, nie zastaví;
   - po 8 s návrat do pokojového stavu, číslo sa presunie do „Práve vyšetrujeme", rad „Nasledujú" sa posunie.
   - Ak prídu dve vyvolania naraz, radia sa do fronty, nikdy sa neprekrývajú.
3. **Mimo ordinačných hodín / pauza** (dorobiť): karta „Práve vyšetrujeme" ukáže „Prestávka – pokračujeme o 13:00" alebo „Ordinujeme Po–Pi 7:30–15:30", TV beží ďalej.
4. **Výpadok dát** (dorobiť): ak backend neodpovie > 60 s, v lište kanála sa zobrazí sivý štítok „offline", posledné známe čísla ostávajú, nič nebliká.

## 4. Dáta a integrácie

- **Formát čísla lístka – buď číslo, alebo písmeno, nikdy oboje.** Sestra pri vydaní lístka zadáva **iba číslo** (1–999, predvolené) **alebo iba písmeno** (A–Z); režim sa nastavuje pre každú ambulanciu v nastaveniach (`ticketMode: "number" | "letter"`). Na TV sa nikdy nezobrazí kombinácia typu „A 24". Ambulanciu rozlišuje **farba dlaždice** (Ambulancia 1 červená `#BC1A21`, Ambulancia 2 sivá `#434242`) a text „Ambulancia 1 · Dvere č. 1". Hlasové oznámenie: „Číslo dvadsaťštyri, ambulancia jedna" / „Písmeno B, ambulancia dva".
- **Orientácia dverí – vždy z pohľadu pacienta, ktorý stojí čelom k TV:** Ambulancia 1 (MUDr. Staško) je **vpravo**, Ambulancia 2 (MUDr. Czetoová) **vľavo**. Šípky, texty „Dvere č. 1 · vpravo / Dvere č. 2 · vľavo“ aj gesto lekára sa riadia `door.side` v konfigurácii.
- **Fotky lekárov** sú v `assets/doctors/` (stasko.jpg, czetoova.jpg – z mamkrcovezily.sk/nas-tim, orez 894 × 1343). V pokojovom stave sú ako okrúhle avatary (76 px) pri každej ambulancii; pri vyvolaní sú „oživené“: pomalý Ken‑Burns zoom (scale 1 → 1.1, 8 s, tam‑späť) a animovaný štítok ruka + šípka v smere dverí (posun 8 px, 1,1 s). Keď budú k dispozícii natočené klipy, nahradia fotku v tom istom ráme.
- **Čísla pacientov** – zdroj je recepcia/lekár (jednoduchý admin panel na tablete alebo PC: tlačidlo „Ďalší" pre každú ambulanciu, „Zopakovať vyvolanie", „Preskočiť"). Odporúčaný tok: backend (napr. Node/PHP na Websupporte, kde beží adna.sk) → WebSocket alebo SSE do TV; fallback polling každých 3 s. Formát: `{ rooms: [{id, name, doctor, door, current}], queue: ["26", …], called: {ticket, roomId, at} }`. Ambulancia 1 = MUDr. Staško, Ambulancia 2 = MUDr. Czetoová – mená, dvere a režim lístkov konfigurovateľné.
- **TV Antik** – ide o IPTV službu Antik Telecom. Na Samsung TV má Antik vlastnú aplikáciu; vloženie živého streamu do našej web appky vyžaduje HLS/RTSP URL z Antik set-top boxu alebo HDMI vstup. Odporúčanie: (a) ak Antik poskytne HLS URL → `<video>` s hls.js v TV okne; (b) inak aplikáciu spúšťať na mini PC / Android TV boxe s HDMI capture alebo PiP. Toto treba overiť s Antikom pred vývojom – dizajn s tým počíta len ako s 16 : 9 čiernym oknom.
- **Správy (ticker)** – RSS: TASR (`https://www.tasr.sk/rss` – overiť aktuálne URL), SITA, Aktuality.sk; štítky Slovensko / Svet / Košice / Zdravie podľa kanála. Načítavať na backende (CORS), cache 10 min, max. 12 titulkov, bez obrázkov, orezať na ~110 znakov. Zobrazovať čas poslednej aktualizácie.
- **Počasie** – Open-Meteo (bez kľúča, `https://api.open-meteo.com/v1/forecast?latitude=48.72&longitude=21.26&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Europe/Bratislava&forecast_days=4`), aktualizácia každých 15 min. Zobrazenie je **ikonické a dynamické podľa aktuálneho stavu**: 7 inline SVG ikon (sú v `prototype/index.html` v bloku počasia a v `design/Main.dc.html` ako `<sc-if>` vetvy) – červený `#BC1A21` slnko/zrážky, sivý `#434242` oblak. Mapovanie WMO `weather_code` → ikona + slovenský popis:
  - 0 → jasno · 1–2 → polooblačno · 3 → oblačno · 45, 48 → hmla
  - 51–67, 80–82 → dážď · 71–77, 85–86 → sneženie · 95–99 → búrka
  Vedľa aktuálneho stavu je mini predpoveď na 3 dni (skratka dňa Po/Ut/St…, ikona 30 px, max/min °C). Teplota zaokrúhlená na celé stupne, popis s veľkým začiatočným písmenom („Polooblačno").
- **Hodiny a dátum** – lokálny čas Europe/Bratislava, formát `HH:MM`, dátum „nedeľa 8. novembra 2026" (prvé písmeno veľké). Aktualizácia každú sekundu, bez blikania.

## 4b. Hlavička – doplnky

- **Kontakt:** pod názvom ambulancie je adresa „AdNa s.r.o. · Krivá 17, Košice" a červená pilulka s ikonou slúchadla **„Call centrum 0918 216 905"** (slovenský zápis; číslo z mamkrcovezily.sk; konfigurovateľné v nastaveniach). Ordinačné hodiny Po–Pia 7:00–15:30.
- **Nadpis** „Ambulancia cievnej chirurgie" je 38 px, aby svojou šírkou lícoval s riadkom adresa + telefón pod ním (oba ~545 px).
- **Hodiny so sekundami:** blok vpravo je **vycentrovaný** (min. šírka 400 px): `HH:MM` 56 px červenou + `:SS` 26 px svetlejšou červenou `#D62B33` na spoločnej základni; tabular‑nums, aktualizácia každú sekundu bez preblikávania (meniť len textový uzol).
- **Dátum + meniny** (číselný formát, pod hodinami, centrovaný): „Nedeľa · 8. 11. 2026 · meniny má **Bohumír**". Kalendár menín je v `data/meniny-sk.json` (kľúč `MM-DD`, 366 položiek vrátane 29. 2.; štátne sviatky sú uvedené názvom sviatku – vtedy zobraz „dnes je {názov}" namiesto „meniny má"). Pred nasadením skontrolovať proti oficiálnemu slovenskému kalendáru menín.

## 5. Sezónne témy dizajnu (`prototype/vianoce.html`, tabule 3 a 4 na plátne)

Celý dizajn sa vie „prezliecť" podľa ročného obdobia či sviatku. Pravidlá:

**Čo sa mení a čo nie.** Mení sa iba *pozadie* (odtiene prechodu vĺn), *dekoračná vrstva* medzi pozadím a oknami (pohyblivé prvky), *hlavička* (akcent na hornej hrane, napr. svetielka) a jeden *pozdrav* v lište TV kanála. **Nikdy** sa nemení logo, čísla pacientov, karta „Práve vyšetrujeme", TV okno ani lišta správ; dekorácie nikdy neprekrývajú text. Max. 30 animovaných prvkov, len `transform`/`opacity`, `pointer-events: none`, `aria-hidden`.

**Katalóg tém** (`themes/*.json` – názov, obdobie, farby, prvky, pozdrav):

| id | Téma | Obdobie (automaticky) | Pohyblivé prvky | Pozdrav |
|---|---|---|---|---|
| `default` | Základná (AdNa) | celoročne, keď nič iné neplatí | – | – |
| `christmas` | Vianoce | **1. 12. 6:00 – 31. 12. 23:59** (potom sa vráti základná / Zima) | padajúce vločky (26 ks, veľkosť 28–58 px, 12–20 s, biele s červeným tieňom), blikajúce svetielka na hornej hrane hlavičky (červená, zlatá #C9A227, biela, zelená #2E7D4F) (jemne sa kolíše), kolísajúci pozdrav v lište kanála | „Pokojné Vianoce praje tím AdNa" |
| `winter` | Zima | 1. 1. – 28./29. 2. | riedke vločky (12 ks), bez vianočných prvkov | – |
| `spring` | Jar | 1. 3. – 31. 5. (mimo Veľkej noci) | poletujúce lupienky (ružové #F0A5A8 / biele) | – |
| `easter` | Veľká noc | Kvetná nedeľa – Veľkonočný pondelok (dátum počítať Gaussovým/Meeusovým algoritmom) | kraslice v červeno‑bielych vzoroch, bahniatka v rohu hlavičky, lupienky | „Požehnané veľkonočné sviatky" |
| `summer` | Leto | 1. 6. – 31. 8. | pomalé slnečné lúče v hornom prechode, svetlejšia paleta | – |
| `autumn` | Jeseň | 1. 9. – 30. 11. | padajúce listy v červeno‑zlatej (#BC1A21, #C9A227, #8E1219) | – |
| `custom` | Vlastná / udalosť | ručne (Deň sestier 12. 5., výročie kliniky, oznam) | podľa nastavenia | voliteľný text |

Priorita: ručne zvolená téma > sviatok (Vianoce, Veľká noc) > ročné obdobie > základná. Zmena témy prebieha o 6:00 (pred otvorením), s 1 s crossfade.

**Automatika a návrh AI.** 14 dní pred začiatkom každého obdobia backend (cron) zavolá Claude API s katalógom tém a značkovými pravidlami a požiada o návrh: výber témy, jemné doladenie akcentov (vždy v rámci červená / biela / čierna / sivá + max. 1 sezónny akcent ako zlatá), text pozdravu a zoznam prvkov. Výsledok sa uloží ako `proposal` so stavom `pending`. Téma sa **zapne automaticky** v stanovený deň aj bez odozvy – návrh je informačný.

**Oznámenie sestre.** Pri prvom prihlásení do panela sestry po vytvorení návrhu sa zobrazí banner (tabuľa 4): „Návrh AI · Sezónna téma „Vianoce 2026" je pripravená – zapne sa 1. 12. 2026 o 6:00, skončí 31. 12. 2026" s tlačidlami **Beriem na vedomie** (banner zmizne pre všetkých), **Upraviť termín** (zmena dátumov / vypnutie prvkov) a **Ponechať základnú** (návrh sa zamietne pre toto obdobie). Oznámenie vidí len prvá prihlásená osoba; ostatní vidia v sekcii Témy riadok „Naplánovaná". Udalosť sa zapisuje do auditu (kto, kedy, čo).

**Ručná voľba.** Sekcia **Témy obrazovky** v paneli sestry: prepínač „Automatické sezónne témy (návrhy AI)", mriežka tém s náhľadom, stavom (Aktívna / Naplánovaná / Dostupná) a tlačidlom **Použiť teraz** (voliteľne „platí do dátumu"); tlačidlo náhľadu otvorí TV obrazovku s danou témou v novom okne. Ručná téma má prednosť pred automatikou až do odvolania alebo do zadaného dátumu; dole je prehľad kalendára sezón.

**Ukončenie.** Každá téma má `endsAt`; o 6:00 nasledujúceho dňa sa aplikuje ďalšia platná téma podľa priority (po 31. 12. je to Zima, resp. základná, ak je Zima vypnutá). Vianočný motív teda zmizne 31. 12. o polnoci.

## 6. Technické požiadavky pre TV

- Fixný layout 1920 × 1080; celý obsah v `.stage` so `transform: scale()` podľa viewportu (viď prototyp), aby fungoval aj na 4K TV.
- Žiadne `100vh/vw` vo vnútri, žiadny scroll, `overflow: hidden` na root.
- Animácie len `transform`/`opacity` (GPU), max. 3 súčasne; `prefers-reduced-motion` rešpektovať.
- Ochrana pred vypálením OLED/LCD: raz za hodinu posunúť celý `.stage` o ±2 px.
- Po strate pripojenia automaticky reconnect; appka sa nikdy nesmie zaseknúť na chybovej hláške – vždy ukáže posledný známy stav.
- Písma, logo a ikony lokálne; žiadne externé CDN v produkcii.
- Prístupnosť: kontrast textu ≥ 4,5 : 1 (už splnené), čísla čitateľné z 6 m (≥ 76 px).

## 7. Čo NEROBIŤ

- Nemeniť logo (farby, orez, pozadie), neumiestňovať ho na červené pozadie bez bielej karty.
- Nepoužívať emoji, gradientové tlačidlá ani farebné pruhy na ľavej strane kariet.
- Nepridávať reklamu či cudzie logá do TV okna ani lišty.
