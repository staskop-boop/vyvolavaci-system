# API kontrakt – vyvolávací systém AdNa (verzia 1)

Spoločný server (`server/`) je jediný zdroj pravdy. Všetky tri aplikácie (tablet, sestra, TV)
komunikujú len s ním cez HTTP (JSON) a WebSocket. Port predvolene `8080`.

## Dátový model (SQLite, súbor `server/data/adna.db`)

| Tabuľka | Účel |
|---|---|
| `settings(key, value)` | nastavenia ako JSON hodnoty |
| `rooms(id, name, sort_order, active)` | ambulancie / pracoviská, upraviteľné |
| `users(id, username, password_hash, role, active, created_at)` | kontá personálu (v1 jedno spoločné, rola `admin`) |
| `sessions(token_hash, user_id, created_at, expires_at, last_seen_at, label)` | prihlásenia (v DB je len SHA-256 hash tokenu) |
| `day_counters(day, last_seq)` | posledné pridelené poradie pre daný deň (Europe/Bratislava) |
| `tickets(...)` | poradové čísla, pozri nižšie |
| `ticket_events(id, ticket_id, type, at, room_id, user_id, note)` | audit a história (vyvolania, zmeny stavu, tlač) |

`tickets`: `id, day ('YYYY-MM-DD'), seq, code ('A001'), status, created_at, called_at, call_count,
room_id, finished_at, request_id (UNIQUE – idempotencia), version, print_status, print_message,
print_attempts, printed_at`, `UNIQUE(day, seq)`.

Časy sú ISO 8601 v UTC (`2026-11-02T07:30:00.000Z`); klienti ich zobrazujú v Europe/Bratislava.

### Stavy čísla

| Hodnota v API | Text v UI |
|---|---|
| `waiting` | Čaká |
| `called` | Vyvolaný |
| `done` | Vybavený |
| `absent` | Neprítomný |

Prechody: `waiting → called` (vyvolanie), `called → called` (zopakovanie, `call_count+1`),
`called → done | absent`, `called | absent | done → waiting` (vrátiť medzi čakajúcich),
`waiting → absent` (neprítomný bez vyvolania). Neplatný prechod = HTTP 409.

### Stav tlače (`print_status`)

| Hodnota | Význam |
|---|---|
| `ok` | dáta odoslané a tlačiareň po tlači hlási stav bez chyby |
| `unverified` | dáta odoslané, ale tlačiareň neodpovedá na stavový dotaz – **nevieme, či sa vytlačilo** |
| `failed` | tlač zlyhala (nedostupná tlačiareň, chýba papier, kryt otvorený, chyba spojenia) |
| `disabled` | tlač je v nastaveniach vypnutá |
| `pending` | prebieha |

## Chyby

Každá chyba: HTTP 4xx/5xx a telo `{"error": {"code": "CONFLICT", "message": "Slovenský text pre používateľa"}}`.
Kódy: `BAD_REQUEST, UNAUTHORIZED, FORBIDDEN, NOT_FOUND, CONFLICT, RATE_LIMITED, SETUP_REQUIRED, INTERNAL`.

## Autentifikácia

* Personál: `POST /api/auth/login` → HttpOnly cookie `adna_session` (SameSite=Strict, platnosť 12 h,
  predĺži sa pri používaní). Heslá: scrypt so soľou. Žiadne heslo nie je v zdrojovom kóde.
* Pri prvom spustení bez konta server vytvorí jednorazový **inštalačný kód** (vypíše ho do konzoly a do
  súboru `server/data/SETUP-KOD.txt`). Heslo sa nastaví na `/sestra/` (obrazovka „Prvotné nastavenie“)
  alebo príkazom `npm run nastav-heslo`.
* Všetky zapisujúce volania personálu musia mať hlavičku `Content-Type: application/json` (ochrana CSRF
  spolu so SameSite cookie).
* Tablet a TV v1 nepotrebujú prihlásenie (prevádzka len v LAN, verejné údaje sú len čísla).
  Registrácia je obmedzená rýchlostným limitom na IP adresu.
* Roly: `staff` (práca so zoznamom), `admin` (aj nastavenia). Spoločné konto v1 má rolu `admin`.

## HTTP – verejné (tablet, TV)

`GET /api/health` → `{ ok: true, time, day }`

`GET /api/public/config` →
```json
{ "clinicName": "AdNa", "ticketDisplaySeconds": 15, "soundEnabled": true, "recentCount": 5,
  "printEnabled": true, "day": "2026-11-02", "serverTime": "..." }
```

`POST /api/kiosk/tickets` telo `{ "requestId": "uuid-v4", "deviceId": "tablet-1" }`
* `requestId` vytvára tablet raz pre jedno stlačenie a pri opakovaní **tej istej** požiadavky ho posiela znova.
* Odpoveď `201` (nové) alebo `200` (rovnaký `requestId` už spracovaný – vráti sa to isté číslo):
```json
{ "duplicate": false,
  "ticket": { "id": 12, "code": "A012", "day": "2026-11-02", "createdAt": "..." },
  "print": { "status": "ok|unverified|failed|disabled", "message": "Slovenský text" } }
```
* Pri `duplicate: true` sa tlač zopakuje iba vtedy, ak predchádzajúca tlač zlyhala (`failed`).

`GET /api/display/state` → stav obrazovky (rovnaký objekt ako WS `display.state`).

## HTTP – personál (cookie)

| Metóda a cesta | Telo | Popis |
|---|---|---|
| `POST /api/setup` | `{setupCode, password}` | prvotné nastavenie hesla (iba keď nie je žiadne konto) |
| `GET /api/setup/status` | – | `{ setupRequired: bool }` |
| `POST /api/auth/login` | `{username, password}` | prihlásenie (`username` v1 = `personal`) |
| `POST /api/auth/logout` | – | odhlásenie |
| `GET /api/auth/me` | – | `{ user: {id, username, role} }` |
| `GET /api/staff/state` | – | `staff.state` (pozri nižšie) |
| `POST /api/staff/tickets/:id/call` | `{roomId, note?}` | vyvolať konkrétne číslo (mimo poradia – `note` vidí len personál) |
| `POST /api/staff/call-next` | `{roomId}` | vyvolať najdlhšie čakajúceho |
| `POST /api/staff/tickets/:id/recall` | `{roomId?}` | zopakovať vyvolanie |
| `POST /api/staff/tickets/:id/done` | – | Vybavený |
| `POST /api/staff/tickets/:id/absent` | – | Neprítomný |
| `POST /api/staff/tickets/:id/requeue` | – | vrátiť medzi čakajúcich (zachová pôvodný čas príchodu) |
| `POST /api/staff/tickets/:id/reprint` | – | znovu vytlačiť lístok (nové číslo sa **nevytvára**) |
| `GET /api/staff/days` | – | `{ days: [{day, total, waiting, called, done, absent}] }` |
| `GET /api/staff/history?day=YYYY-MM-DD` | – | `{ day, tickets: [...], events: [...] }` |
| `GET /api/admin/settings` / `PUT` | čiastočný objekt nastavení | nastavenia (rola admin) |
| `GET /api/admin/rooms` / `POST` / `PUT /:id` / `DELETE /:id` | `{name, sortOrder, active}` | ambulancie |
| `POST /api/admin/password` | `{currentPassword, newPassword}` | zmena hesla (odhlási ostatné relácie) |
| `POST /api/admin/close-day` | `{confirm: "UKONČIŤ"}` | ukončenie dňa: čakajúci/vyvolaní dnes → Neprítomný |
| `POST /api/admin/purge` | `{confirm: "VYMAZAŤ", password, scope: "history" \| "all"}` | vymazanie údajov (`history` = všetko okrem dneška) |
| `POST /api/admin/printer/test` | – | skúšobná tlač / stav tlačiarne |

Odpoveď na akcie s číslom: `{ ticket: TicketStaff }`. Pri súbehu (iná sestra už pacienta vyvolala) `409 CONFLICT`
so správou napr. „Číslo A012 už medzičasom vyvolala iná sestra (Ambulancia č. 2).“

`TicketStaff`:
```json
{ "id": 12, "code": "A012", "day": "2026-11-02", "seq": 12, "status": "waiting",
  "createdAt": "...", "calledAt": null, "finishedAt": null, "callCount": 0,
  "roomId": null, "roomName": null, "version": 1,
  "print": { "status": "ok", "message": "...", "attempts": 1, "printedAt": "..." } }
```

## WebSocket `ws://SERVER:8080/ws?channel=display|staff`

* `display` – verejný (TV, tablet). `staff` – vyžaduje cookie personálu, inak sa spojenie zatvorí kódom `4401`.
* Server posiela každých 15 s `{"type":"ping"}`; klient môže poslať `{"type":"ping"}` a dostane `{"type":"pong"}`.
  Ak klient 35 s nič nedostane, spojenie považuje za stratené a pripája sa znova (1 s, 2 s, 4 s … max 10 s).
* Po pripojení server vždy pošle **úplný stav** – klient po obnovení spojenia nič nedopočítava.

Správy server → klient:

`{"type":"display.state", "rev": 41, "state": DisplayState}` – kanál `display`

```json
DisplayState = {
  "clinicName": "AdNa", "soundEnabled": true, "recentCount": 5, "day": "2026-11-02",
  "current": { "callId": 88, "code": "A012", "roomName": "Ambulancia č. 1", "at": "...", "repeat": false } | null,
  "recent": [ { "callId": 87, "code": "A011", "roomName": "USG pracovisko", "at": "...", "repeat": false } ]
}
```
`current` = posledné vyvolanie dnešného dňa, `recent` = predchádzajúce (bez `current`, každé číslo najviac raz).

`{"type":"call", "call": {callId, code, roomName, at, repeat}}` – kanál `display` aj `staff`;
príde **len** pri novom vyvolaní/zopakovaní (nie po pripojení). Podľa neho obrazovka prehrá zvuk a zvýrazní číslo.

`{"type":"staff.state", "rev": 41, "state": StaffState}` – kanál `staff`

```json
StaffState = {
  "day": "2026-11-02", "serverTime": "...",
  "tickets": [TicketStaff],            // všetky dnešné čísla
  "counts": { "waiting": 3, "called": 1, "done": 7, "absent": 1 },
  "rooms": [ { "id": 1, "name": "Ambulancia č. 1", "sortOrder": 1, "active": true } ],
  "settings": { ... rovnaké ako /api/admin/settings ... },
  "printer": { "enabled": true, "lastStatus": "ok", "lastMessage": "...", "lastCheckedAt": "..." },
  "previousDayOpen": { "day": "2026-11-01", "count": 2 } | null
}
```

## Integračné pravidlá

1. Čísla prideľuje iba server v transakcii `BEGIN IMMEDIATE` (SQLite) – `day_counters` + `UNIQUE(day, seq)`.
2. Idempotencia registrácie: `UNIQUE(request_id)`.
3. Vyvolanie je podmienené aktuálnym stavom (`UPDATE … WHERE status='waiting'`); 0 zmenených riadkov = 409.
4. Deň sa určuje v pásme Europe/Bratislava; staré nevybavené čísla sa do nového dňa neprenášajú,
   ostávajú v histórii (`previousDayOpen` upozorní personál).
5. Klienti nikdy neukladajú stav len lokálne – po reštarte/obnovení načítajú úplný stav zo servera.
6. Na verejné kanály (`display`, tablet) nikdy neidú poznámky personálu ani iné interné údaje.

## Verzia 2 – kartičky, plánovaný čas, obrazovka s TV programom a správami

Databáza: `tickets.planned_at` (ISO UTC, môže byť `null`) a `tickets.source` (`kiosk` | `card`) – pridajú sa automaticky
pri štarte servera (`PRAGMA user_version = 2`). Udalosť `ticket_events.type = 'planned'` pri zmene času.

| Metóda a cesta | Telo | Popis |
|---|---|---|
| `POST /api/staff/cards` | `{cardNo: "12", plannedTime: "09:30" \| null}` | sestra pridelí pacientovi označenie – číslo alebo písmeno (1 – 6 písmen/číslic, napr. `7`, `A`, `K12`; malé písmená sa zmenia na veľké). To isté označenie nemôže v jeden deň súčasne čakať/byť vyvolané dvakrát → `409`. Bez tlače. |
| `POST /api/staff/tickets/:id/planned` | `{plannedTime: "09:30" \| null}` | spárovanie/zmena plánovaného času (aj pre čísla z tabletu) |
| `GET /api/display/news` | – | `{enabled, updatedAt, items: [{title, source, at}]}` – titulky pre lištu (verejné) |
| `GET /api/admin/news`, `POST /api/admin/news/refresh` | – | stav jednotlivých RSS zdrojov (admin) |

Poradie čakajúcich (sestra, „Vyvolať ďalšieho“, obrazovka) = `COALESCE(planned_at, created_at)`, potom `seq`.

`DisplayState` má navyše:
```json
{ "serverTime": "...", "queue": [ { "code": "12", "plannedAt": "..." | null } ], "waitingCount": 6,
  "clinicDelayMinutes": 18, "onTimeMinutes": 3, "ticketDisplaySeconds": 15, "tvSource": "https://webtv.sk/", "newsEnabled": true }
```
* `clinicDelayMinutes` = (čas posledného vyvolania − jeho plánovaný čas) v minútach; záporné = ambulancia je vpred.
* Obrazovka pre každé čakajúce číslo zobrazí odchýlku `max(clinicDelayMinutes, teraz − plánovaný čas)`:
  `> onTimeMinutes` červené „+N min“, `< −onTimeMinutes` zelené „o N min skôr“, inak zelené „načas“.
* Na obrazovku idú iba čísla kartičiek a plánované časy – žiadne mená.

Nové nastavenia (`/api/admin/settings`): `queueCount` (0 – 15), `onTimeMinutes` (0 – 30), `tvSource` (http/https alebo prázdne),
`news: { enabled, refreshMinutes, maxAgeHours, feeds: [{name, url}], exclude: [slová] }`.
Server sťahuje RSS/Atom každých `refreshMinutes`, berie najviac 6 najnovších titulkov z každého zdroja (max. `maxAgeHours` starých),
striedá zdroje, odstráni duplicity a titulky s vylúčenými slovami (predvolene násilie/úmrtia – čakáreň ambulancie).
Nedostupný zdroj neprekáža, ostanú posledné úspešne stiahnuté titulky.

## Verzia 2.1 – dve ambulancie s vlastnými kontami, spoločná TV, hlásenie meškania

* `users.room_id` – pracovisko (ambulancia), ku ktorému konto patrí; `null` = všetky. `tickets.home_room_id` – pracovisko pacienta
  (nastaví sa pri `POST /api/staff/cards` z `roomId` v tele, inak z konta sestry).
* Kontá (admin): `GET /api/admin/users`, `POST /api/admin/users {username, password, roomId, role: "staff"|"admin"}`,
  `PUT /api/admin/users/:id {roomId?, role?, active?, password?}`. Posledné aktívne admin konto nemožno vypnúť ani znížiť.
  Prihlásenie `POST /api/auth/login {username, password}`; `user` obsahuje `roomId`.
* `POST /api/staff/call-next {roomId}` vyberá len pacientov s `home_room_id = roomId` alebo bez pracoviska.
* Označenie pacienta je jedinečné naprieč pracoviskami (TV je spoločná); `409` uvádza, ktoré pracovisko ho používa.
* `POST /api/staff/rooms/:id/delay {minutes: 5–300 | null, text?}` – sestra nahlási meškanie pracoviska (napr. predĺžený výkon).
  Zruší sa `minutes: null` alebo automaticky pri ďalšom vyvolaní z toho pracoviska.
* `DisplayState.queue[]` má `roomId`, `roomName`; `DisplayState.rooms[] = {id, name, lastCallDelayMinutes, reported: {minutes, text, at} | null}`;
  `longDelayMinutes` (nastavenie, predvolene 30).
* Sklz pracoviska na TV = max(nahlásené meškanie, sklz pri poslednom vyvolaní, čas od termínu najskôr objednaného čakajúceho).
  Odchýlka pacienta = max(sklz jeho pracoviska, teraz − jeho termín); nad 30 min sa zaokrúhľuje na 5 min a zobrazuje v h/min.
  Pri nahlásenom meškaní alebo sklze ≥ `longDelayMinutes` TV ukáže oznam „Ambulancia X: čakanie dlhšie o … – Ďakujeme za trpezlivosť“.

## Verzia 2.2 – lekár na ambulancii a smerová šípka

* `rooms.direction` = `right` | `left` | `straight` | `''` – smer k ambulancii z čakárne (šípka na TV). Predvolene
  *Ambulancia č. 1 = vpravo*, *Ambulancia č. 2 = vľavo*; mení sa v Nastaveniach → Ambulancie (`PUT /api/admin/rooms/:id {direction}`).
* `POST /api/staff/rooms/:id/doctor {name}` – lekár, ktorý dnes ordinuje v ambulancii (2 – 60 znakov). Platí len pre dnešný deň,
  dá sa kedykoľvek zmeniť. Sestra ho zadáva povinne po prihlásení (okno sa ukáže, kým nie je zadaný). `StaffState.doctors = {roomId: meno}`.
* Nastavenie `doctorList` – mená na výber (predvolene lekári z mamkrcovezily.sk/nas-tim).
* `call`, `DisplayState.current/recent[]` majú `doctorName` a `direction`; `queue[]` a `rooms[]` majú `doctorName`.
* TV pri vyvolaní ukáže namiesto názvu ambulancie meno lekára (bez titulov za menom), pod ním malým písmom ambulanciu,
  a veľkú pohyblivú šípku na strane, kde je ambulancia. Ak lekár nie je zadaný, zobrazí sa názov ambulancie.

## Verzia 2.3 – mimoriadny oznam

- `POST /api/staff/announcement` `{ text }` (max. 300 znakov) – zapne/zmení oznam; `{ text: null }` alebo prázdny text ho zruší. Odpoveď `{ announcement }`.
- `displayState.announcement` a `staffState.announcement` = `{ text, at, id }` alebo `null`. Oznam platí, kým ho niektorá sestra nezruší (vidia ho obe ambulancie).
- TV: veľký žltý pruh v hornej časti TV zóny a namiesto lišty správ; nový oznam (zmena `id`) zaznie signálom, načítanie stránky nie.

## Verzia 3 – dizajn obrazovky z Claude Design (2026-11-08)

Podklad: `docs/dizajn-v3/DIZAJN-MANUAL.md` a `tokens.css`. Obrazovka je pevná plocha 1920 × 1080 px, ktorá sa zmenší/zväčší podľa TV.

- `displayState.rooms[].current` – posledné vyvolané číslo každej ambulancie („Práve vyšetrujeme“); `current.roomId`, `recent[].roomId`; udalosť `call` nesie `roomId`.
- `displayState.screen` = `{ title, address, phone, info[], theme, tvLabel, weatherEnabled }` – hlavička a „Informácie pre pacientov“ (`**slovo**` = tučné).
- Nastavenie `screen` (PUT /api/admin/settings): `title`, `address`, `phone`, `tvLabel`, `info` (max. 6), `theme` = `auto` | `default` | `christmas`, `weather` = `{ enabled, city, lat, lon }`.
- `GET /api/display/weather` → `{ enabled, city, updatedAt, temp, icon, text, days: [{ date, icon, text, max, min }] }`; server sťahuje Open-Meteo každých 15 min, pri výpadku ostáva posledný stav. Ikony: `clear | partly | cloudy | fog | rain | snow | storm` (mapovanie WMO kódov podľa manuálu).
- Zdroj správ má voliteľný `tag` (Slovensko, Svet, Košice, Zdravie) – zobrazí sa ako štítok v lište; položky `/api/display/news` majú `tag`.
- TV: dve výzvy naraz sa radia za sebou (aktuálna ostane aspoň 6 s); vrátené vyvolanie výzvu hneď ukončí; štítok „offline“ až po 60 s výpadku (`?offline=N` skráti na N s); `?tema=vianoce` / `?tema=zakladna` = náhľad témy; raz za hodinu posun plochy o ±2 px (ochrana pred vypálením).
- Fotky lekárov: `apps/tv/web/assets/doctors/<priezvisko bez diakritiky>.jpg` (napr. `stasko.jpg`, `czetoova.jpg`); ak fotka chýba, zobrazia sa iniciály.
- Písma Inter a Plus Jakarta Sans sú lokálne v `apps/tv/web/fonts` (licencia SIL OFL 1.1).

## Verzia 3.1 – hlasové hlásenie

- Nastavenie `voice` = `{ enabled, rate (0,6 – 1,4), room }`; `displayState.voice` (vypnutý zvuk = vypnutý aj hlas).
- TV po signáli marimba (~1,45 s) prečíta cez Web Speech API slovenským hlasom: „Číslo dvadsaťpäť, ambulancia jedna.“,
  „Písmeno bé, ambulancia dva.“, „Označenie ká dvanásť, …“. Výber hlasu: sk-* „Online (Natural)“ (Viktória) → iný sk hlas.
  Bez slovenského hlasu sa nehlási a v lište TV je štítok „Chýba slovenský hlas“. `?hlas=test` = skúšobné hlásenie.
