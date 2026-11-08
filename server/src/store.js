'use strict';
const { EventEmitter } = require('node:events');
const { tx } = require('./db');
const clock = require('./clock');
const printer = require('./printer');
const log = require('./log');

class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const bad = (m) => new AppError(400, 'BAD_REQUEST', m);
const notFound = (m = 'Záznam neexistuje.') => new AppError(404, 'NOT_FOUND', m);
const conflict = (m) => new AppError(409, 'CONFLICT', m);

const DEFAULT_SETTINGS = {
  clinicName: 'AdNa',
  ticketPrefix: 'A',
  ticketDisplaySeconds: 15,
  soundEnabled: true,
  recentCount: 5,
  // v2 – obrazovka s TV programom
  queueCount: 8,            // koľko čísel „na rade“ ukáže TV
  onTimeMinutes: 3,         // odchýlka ± v minútach, ktorá sa ešte zobrazí ako „načas“
  longDelayMinutes: 30,     // od tohto meškania ukáže TV oznam „predĺžený výkon – ďakujeme za trpezlivosť“
  roomDelays: {},
  // v2.2: zoznam lekárov na výber (sestra môže zadať aj iné meno) – z mamkrcovezily.sk/nas-tim (2026-11-08)
  doctorList: ['MUDr. Pavel Staško, PhD., MHA, MPH', 'MUDr. Adela Czetöová', 'MUDr. Mária Kubíková, PhD.', 'MUDr. Filip Kúdela', 'MUDr. Dominik Kovaľ'],           // { [roomId]: { minutes, text, at } } – hlásenie meškania od sestry; zruší sa pri ďalšom vyvolaní z pracoviska
  // v3 – dizajn z Claude Design (2026-11-08): hlavička, informácie pre pacientov, počasie, sezónne témy
  screen: {
    title: 'Ambulancia cievnej chirurgie',
    address: 'AdNa s.r.o. · Krivá 17, Košice',
    phone: 'Call centrum 0918 216 905',
    // **tučné** = zvýraznené slovo
    info: [
      'Pripravte si **kartičku poistenca** a výmenný lístok od svojho lekára.',
      'Po vyvolaní čísla vstúpte do ambulancie do **2 minút**, inak bude číslo zaradené na koniec poradia.',
      'Objednaní pacienti majú **prednosť** v čase svojho termínu. Ďakujeme za trpezlivosť.',
      'Čas objednania je **orientačný** – je to čas, kedy idete k sestre na prvotné vyšetrenie. Poradie sa prispôsobuje priebehu ambulancie počas dňa.',
    ],
    weather: { enabled: true, city: 'Košice', lat: 48.72, lon: 21.26 },
    theme: 'auto',          // 'auto' = podľa kalendára (Vianoce 1. – 31. 12.), 'default', 'christmas'
    tvLabel: 'TV Antik',
  },
  // v3.1 – hlasové hlásenie po zvukovom signáli (Pali 2026-11-08): „Číslo dvadsaťpäť, ambulancia jedna“
  voice: { enabled: true, rate: 0.9, room: true },
  tvSource: '',             // adresa TV prehrávača vo vloženom okne (prázdne = zónu vyplní samostatné okno / box)
  news: {
    enabled: true,
    refreshMinutes: 10,
    maxAgeHours: 24,
    feeds: [
      { name: 'TASR', tag: 'Slovensko', url: 'https://www.teraz.sk/rss/slovensko.rss' },
      { name: 'Aktuality.sk', tag: 'Slovensko', url: 'https://www.aktuality.sk/rss/' },
      { name: 'SME', tag: 'Slovensko', url: 'https://www.sme.sk/rss-title' },
      { name: 'Denník N', tag: 'Slovensko', url: 'https://dennikn.sk/feed/' },
      { name: 'Pravda', tag: 'Slovensko', url: 'https://www.pravda.sk/rss/xml/' },
      { name: 'Korzár', tag: 'Košice', url: 'https://korzar.sme.sk/rss-title' },
      { name: 'BBC', tag: 'Svet', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
      { name: 'The Guardian', tag: 'Svet', url: 'https://www.theguardian.com/world/rss' },
    ],
    // Čakáreň ambulancie: titulky s týmito slovami (časť slova, bez ohľadu na veľkosť písmen) sa nezobrazia.
    exclude: ['vražd', 'zavraž', 'zomrel', 'zahynul', 'úmrt', 'mŕtv', 'samovražd', 'teror', 'streľb', 'znásiln', 'killed', 'dead', 'murder'],
  },
  ticketInstruction: 'Posaďte sa, prosím, a sledujte obrazovku v čakárni.',
  printer: {
    enabled: false, host: '', port: 9100,
    encoding: 'ascii',     // 'ascii' = bez diakritiky (funguje všade), 'cp852' = slovenské znaky
    codePage: 18,          // číslo kódovej stránky CP852 pre ESC t n (Epson: 18) – podľa manuálu tlačiarne
    cut: true, statusCheck: true, footer: '',
    connectTimeoutMs: 3000, statusTimeoutMs: 1500,
  },
};

const DEMO_ROOMS = ['Ambulancia č. 1', 'Ambulancia č. 2', 'USG pracovisko'];
const STATUS_TEXT = { waiting: 'Čaká', called: 'Vyvolaný', done: 'Vybavený', absent: 'Neprítomný' };

function clampInt(v, min, max, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`Hodnota „${name}“ musí byť celé číslo od ${min} do ${max}.`);
  return n;
}
function str(v, max, name, { allowEmpty = false } = {}) {
  if (typeof v !== 'string') throw bad(`Hodnota „${name}“ musí byť text.`);
  const s = v.trim();
  if (!allowEmpty && !s) throw bad(`Hodnota „${name}“ nesmie byť prázdna.`);
  if (s.length > max) throw bad(`Hodnota „${name}“ je príliš dlhá (max. ${max} znakov).`);
  return s;
}

class Store extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.rev = 0;
    this.printing = new Map(); // ticketId -> Promise (prebiehajúca tlač)
    this.currentDay = clock.today();
    this.seed();
  }

  seed() {
    const seeded = this.db.prepare("SELECT value FROM settings WHERE key = 'seeded'").get();
    if (seeded) return;
    tx(this.db, () => {
      if (!this.db.prepare('SELECT 1 FROM rooms LIMIT 1').get()) {
        const DIR = ['right', 'left', ''];   // AdNa: č. 1 vpravo, č. 2 vľavo
        DEMO_ROOMS.forEach((n, i) => this.db.prepare('INSERT INTO rooms (name, sort_order, direction) VALUES (?, ?, ?)').run(n, i + 1, DIR[i] || ''));
      }
      this.db.prepare("INSERT INTO settings (key, value) VALUES ('seeded', 'true')").run();
    });
  }

  // ---------- nastavenia ----------
  getSettings() {
    const rows = this.db.prepare("SELECT key, value FROM settings WHERE key <> 'seeded'").all();
    const s = structuredClone(DEFAULT_SETTINGS);
    for (const r of rows) {
      try {
        const v = JSON.parse(r.value);
        if (r.key === 'printer') Object.assign(s.printer, v);
        else if (r.key === 'news') Object.assign(s.news, v);
        else if (r.key === 'voice') Object.assign(s.voice, v);
        else if (r.key === 'screen') { const w = { ...s.screen.weather, ...(v.weather || {}) }; Object.assign(s.screen, v); s.screen.weather = w; }
        else if (r.key in s) s[r.key] = v;
      } catch {}
    }
    return s;
  }

  updateSettings(patch) {
    if (!patch || typeof patch !== 'object') throw bad('Chýbajú nastavenia.');
    const cur = this.getSettings();
    const next = structuredClone(cur);
    if ('clinicName' in patch) next.clinicName = str(patch.clinicName, 60, 'Názov');
    if ('ticketPrefix' in patch) {
      const p = str(patch.ticketPrefix, 2, 'Predpona čísla').toUpperCase();
      if (!/^[A-Z]{1,2}$/.test(p)) throw bad('Predpona čísla môže obsahovať 1 – 2 písmená bez diakritiky.');
      next.ticketPrefix = p;
    }
    if ('ticketDisplaySeconds' in patch) next.ticketDisplaySeconds = clampInt(patch.ticketDisplaySeconds, 5, 120, 'Čas zobrazenia čísla');
    if ('soundEnabled' in patch) next.soundEnabled = !!patch.soundEnabled;
    if ('recentCount' in patch) next.recentCount = clampInt(patch.recentCount, 0, 10, 'Počet naposledy vyvolaných');
    if ('queueCount' in patch) next.queueCount = clampInt(patch.queueCount, 0, 15, 'Počet čísel na rade');
    if ('doctorList' in patch) {
      if (!Array.isArray(patch.doctorList) || patch.doctorList.length > 40) throw bad('Zoznam lekárov môže mať najviac 40 mien.');
      next.doctorList = [...new Set(patch.doctorList.map((n) => str(String(n), 60, 'Meno lekára', { allowEmpty: true })).filter(Boolean))];
    }
    if ('longDelayMinutes' in patch) next.longDelayMinutes = clampInt(patch.longDelayMinutes, 10, 240, 'Hranica veľkého meškania');
    if ('onTimeMinutes' in patch) next.onTimeMinutes = clampInt(patch.onTimeMinutes, 0, 30, 'Tolerancia „načas“');
    if ('tvSource' in patch) {
      const u = str(patch.tvSource, 500, 'Adresa TV prehrávača', { allowEmpty: true });
      if (u && !/^https?:\/\/[^\s]+$/i.test(u)) throw bad('Adresa TV prehrávača musí začínať http:// alebo https://.');
      next.tvSource = u;
    }
    if (patch.news && typeof patch.news === 'object') {
      const n = patch.news, nn = next.news;
      if ('enabled' in n) nn.enabled = !!n.enabled;
      if ('refreshMinutes' in n) nn.refreshMinutes = clampInt(n.refreshMinutes, 2, 120, 'Obnova správ');
      if ('maxAgeHours' in n) nn.maxAgeHours = clampInt(n.maxAgeHours, 1, 168, 'Vek správ');
      if ('feeds' in n) {
        if (!Array.isArray(n.feeds) || n.feeds.length > 20) throw bad('Zoznam zdrojov správ môže mať najviac 20 položiek.');
        nn.feeds = n.feeds.map((f) => {
          const name = str(f && f.name, 40, 'Názov zdroja');
          const url = str(f && f.url, 500, 'Adresa zdroja');
          if (!/^https?:\/\/[^\s]+$/i.test(url)) throw bad(`Adresa zdroja „${name}“ musí začínať http:// alebo https://.`);
          const tag = f.tag ? str(String(f.tag), 20, 'Štítok zdroja', { allowEmpty: true }) : '';
          return tag ? { name, tag, url } : { name, url };
        });
      }
      if ('exclude' in n) {
        if (!Array.isArray(n.exclude) || n.exclude.length > 100) throw bad('Zoznam vylúčených slov je neplatný.');
        nn.exclude = n.exclude.map((w) => str(String(w), 40, 'Vylúčené slovo')).filter(Boolean);
      }
    }
    if (patch.screen && typeof patch.screen === 'object') {
      const c = patch.screen, ns = next.screen;
      if ('title' in c) ns.title = str(c.title, 60, 'Nadpis obrazovky', { allowEmpty: true });
      if ('address' in c) ns.address = str(c.address, 80, 'Adresa', { allowEmpty: true });
      if ('phone' in c) ns.phone = str(c.phone, 60, 'Telefón', { allowEmpty: true });
      if ('tvLabel' in c) ns.tvLabel = str(c.tvLabel, 40, 'Názov TV', { allowEmpty: true });
      if ('info' in c) {
        if (!Array.isArray(c.info) || c.info.length > 6) throw bad('Informácií pre pacientov môže byť najviac 6.');
        ns.info = c.info.map((t) => str(String(t), 220, 'Informácia pre pacientov', { allowEmpty: true })).filter(Boolean);
      }
      if ('theme' in c) { if (!['auto', 'default', 'christmas'].includes(c.theme)) throw bad('Neznáma téma obrazovky.'); ns.theme = c.theme; }
      if (c.weather && typeof c.weather === 'object') {
        const w = c.weather, nw = ns.weather;
        if ('enabled' in w) nw.enabled = !!w.enabled;
        if ('city' in w) nw.city = str(w.city, 40, 'Mesto', { allowEmpty: true });
        for (const [k, lo, hi] of [['lat', -90, 90], ['lon', -180, 180]]) if (k in w) {
          const n = Number(w[k]); if (!Number.isFinite(n) || n < lo || n > hi) throw bad('Neplatná zemepisná súradnica.'); nw[k] = n;
        }
      }
    }
    if (patch.voice && typeof patch.voice === 'object') {
      const v = patch.voice;
      if ('enabled' in v) next.voice.enabled = !!v.enabled;
      if ('room' in v) next.voice.room = !!v.room;
      if ('rate' in v) { const r = Number(v.rate); if (!(r >= 0.6 && r <= 1.4)) throw bad('Rýchlosť hlasu musí byť od 0,6 do 1,4.'); next.voice.rate = Math.round(r * 100) / 100; }
    }
    if ('ticketInstruction' in patch) next.ticketInstruction = str(patch.ticketInstruction, 120, 'Pokyn na lístku');
    if (patch.printer && typeof patch.printer === 'object') {
      const p = patch.printer, np = next.printer;
      if ('enabled' in p) np.enabled = !!p.enabled;
      if ('host' in p) {
        np.host = str(p.host, 100, 'Adresa tlačiarne', { allowEmpty: true });
        if (np.host && !/^[A-Za-z0-9.\-:]+$/.test(np.host)) throw bad('Adresa tlačiarne má neplatný tvar (napr. 192.168.1.50).');
      }
      if ('port' in p) np.port = clampInt(p.port, 1, 65535, 'Port tlačiarne');
      if ('encoding' in p) { if (!['ascii', 'cp852'].includes(p.encoding)) throw bad('Neznáme kódovanie.'); np.encoding = p.encoding; }
      if ('codePage' in p) np.codePage = clampInt(p.codePage, 0, 255, 'Kódová stránka');
      if ('cut' in p) np.cut = !!p.cut;
      if ('statusCheck' in p) np.statusCheck = !!p.statusCheck;
      if ('footer' in p) np.footer = str(p.footer, 120, 'Pätička lístka', { allowEmpty: true });
      if ('connectTimeoutMs' in p) np.connectTimeoutMs = clampInt(p.connectTimeoutMs, 500, 15000, 'Časový limit spojenia');
      if ('statusTimeoutMs' in p) np.statusTimeoutMs = clampInt(p.statusTimeoutMs, 200, 10000, 'Časový limit stavu');
    }
    tx(this.db, () => {
      const up = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      for (const [k, v] of Object.entries(next)) up.run(k, JSON.stringify(v));
    });
    this.changed('settings');
    return next;
  }

  // ---------- ambulancie ----------
  listRooms({ activeOnly = false } = {}) {
    return this.db.prepare(`SELECT * FROM rooms ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort_order, id`).all()
      .map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order, active: !!r.active, direction: r.direction || '' }));
  }
  getRoom(id) {
    const r = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(Number(id));
    return r ? { id: r.id, name: r.name, sortOrder: r.sort_order, active: !!r.active, direction: r.direction || '' } : null;
  }

  // ---------- v2.2: lekár, ktorý dnes ordinuje v ambulancii (zadá sestra na začiatku dňa, dá sa meniť) ----------
  doctorsToday() {
    const raw = this.db.prepare("SELECT value FROM settings WHERE key = 'doctors'").get();
    let d = null; try { d = raw ? JSON.parse(raw.value) : null; } catch {}
    return d && d.day === clock.today() ? d.byRoom || {} : {};
  }
  setDoctor(roomId, name, userId) {
    const room = this.requireRoom(roomId);
    const n = str(name == null ? '' : String(name), 60, 'Lekár');
    if (n.length < 2) throw bad('Zadajte meno a priezvisko lekára (alebo iniciály).');
    const byRoom = { ...this.doctorsToday(), [room.id]: n };
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('doctors', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ day: clock.today(), byRoom }));
    log.info('Lekár v ambulancii', { room: room.name, userId });
    this.changed('doctors');
    return { doctors: byRoom };
  }
  // ---------- v2.3: mimoriadny oznam pre celú čakáreň ----------
  announcement() {
    const raw = this.db.prepare("SELECT value FROM settings WHERE key = 'announcement'").get();
    let a = null; try { a = raw ? JSON.parse(raw.value) : null; } catch {}
    return a && a.text ? a : null;
  }
  setAnnouncement(text, user) {
    const t = text == null ? '' : str(String(text), 300, 'Oznam', { allowEmpty: true });
    const a = t ? { text: t, at: clock.nowIso(), id: Date.now() } : null;
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('announcement', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(a));
    log.info(a ? 'Mimoriadny oznam zapnutý' : 'Mimoriadny oznam zrušený', { user: user && user.username });
    this.changed('announcement');
    return { announcement: a };
  }

  /** Údaje pre TV o ambulancii: meno lekára (ak je zadané) a smer šípky. */
  roomDisplay(roomId) {
    const r = roomId != null ? this.getRoom(roomId) : null;
    if (!r) return { doctorName: null, direction: '' };
    return { doctorName: this.doctorsToday()[r.id] || null, direction: r.direction };
  }
  createRoom(b) {
    const name = str(b?.name, 60, 'Názov ambulancie');
    const max = this.db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM rooms').get().m;
    const sort = b?.sortOrder != null ? clampInt(b.sortOrder, 0, 999, 'Poradie') : max + 1;
    const id = Number(this.db.prepare('INSERT INTO rooms (name, sort_order, active) VALUES (?,?,?)').run(name, sort, b?.active === false ? 0 : 1).lastInsertRowid);
    this.changed('rooms');
    return this.getRoom(id);
  }
  updateRoom(id, b) {
    const r = this.getRoom(id);
    if (!r) throw notFound('Ambulancia neexistuje.');
    const name = b?.name != null ? str(b.name, 60, 'Názov ambulancie') : r.name;
    const sort = b?.sortOrder != null ? clampInt(b.sortOrder, 0, 999, 'Poradie') : r.sortOrder;
    const active = b?.active != null ? (b.active ? 1 : 0) : (r.active ? 1 : 0);
    const dir = b?.direction != null ? String(b.direction) : r.direction;
    if (!['', 'right', 'left', 'straight'].includes(dir)) throw bad('Neplatný smer.');
    if (!active && this.listRooms({ activeOnly: true }).filter((x) => x.id !== r.id).length === 0) throw conflict('Musí zostať aspoň jedna aktívna ambulancia.');
    this.db.prepare('UPDATE rooms SET name = ?, sort_order = ?, active = ?, direction = ? WHERE id = ?').run(name, sort, active, dir, r.id);
    this.changed('rooms');
    return this.getRoom(r.id);
  }
  deleteRoom(id) {
    const r = this.getRoom(id);
    if (!r) throw notFound('Ambulancia neexistuje.');
    if (this.listRooms({ activeOnly: true }).filter((x) => x.id !== r.id).length === 0) throw conflict('Musí zostať aspoň jedna aktívna ambulancia.');
    const used = this.db.prepare('SELECT 1 FROM tickets WHERE room_id = ? LIMIT 1').get(r.id);
    if (used) {
      // Ambulancia je v histórii – len ju deaktivujeme, aby história ostala čitateľná.
      this.db.prepare('UPDATE rooms SET active = 0 WHERE id = ?').run(r.id);
    } else {
      this.db.prepare('DELETE FROM rooms WHERE id = ?').run(r.id);
    }
    this.changed('rooms');
    return { deleted: !used, deactivated: !!used };
  }

  // ---------- čísla ----------
  rowToTicket(t) {
    if (!t) return null;
    return {
      id: t.id, code: t.code, day: t.day, seq: t.seq, status: t.status, statusText: STATUS_TEXT[t.status],
      createdAt: t.created_at, calledAt: t.called_at, finishedAt: t.finished_at, callCount: t.call_count,
      roomId: t.room_id, roomName: t.room_name ?? null, version: t.version,
      plannedAt: t.planned_at ?? null, source: t.source || 'kiosk',
      homeRoomId: t.home_room_id ?? null, homeRoomName: t.home_room_name ?? null,
      print: { status: t.print_status, message: t.print_message, attempts: t.print_attempts, printedAt: t.printed_at },
    };
  }
  getTicketRow(id) {
    return this.db.prepare('SELECT t.*, r.name AS room_name, h.name AS home_room_name FROM tickets t LEFT JOIN rooms r ON r.id = t.room_id LEFT JOIN rooms h ON h.id = t.home_room_id WHERE t.id = ?').get(Number(id));
  }
  getTicket(id) { return this.rowToTicket(this.getTicketRow(id)); }

  formatCode(prefix, seq) { return prefix + String(seq).padStart(3, '0'); }

  /** Registrácia pacienta – idempotentná podľa requestId. */
  async register(requestId, deviceId) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) throw bad('Chýba alebo je neplatný identifikátor požiadavky.');
    const dev = typeof deviceId === 'string' ? deviceId.slice(0, 60) : null;
    const settings = this.getSettings();
    const res = tx(this.db, () => {
      const ex = this.db.prepare('SELECT id FROM tickets WHERE request_id = ?').get(requestId);
      if (ex) return { id: ex.id, duplicate: true };
      const day = clock.today();
      const { last_seq: seq } = this.db.prepare(`INSERT INTO day_counters (day, last_seq) VALUES (?, 1)
        ON CONFLICT(day) DO UPDATE SET last_seq = last_seq + 1 RETURNING last_seq`).get(day);
      const now = clock.nowIso();
      const id = Number(this.db.prepare(`INSERT INTO tickets (day, seq, code, status, created_at, request_id, device_id, print_status)
        VALUES (?, ?, ?, 'waiting', ?, ?, ?, 'pending')`).run(day, seq, this.formatCode(settings.ticketPrefix, seq), now, requestId, dev).lastInsertRowid);
      this.db.prepare("INSERT INTO ticket_events (ticket_id, type, at) VALUES (?, 'created', ?)").run(id, now);
      return { id, duplicate: false };
    });
    if (!res.duplicate) this.changed('tickets');
    let row = this.getTicketRow(res.id);
    let print;
    if (this.printing.has(row.id)) {
      print = await this.printing.get(row.id);
    } else if (!res.duplicate || row.print_status === 'failed' || row.print_status === 'pending') {
      print = await this.print(row.id, { reprint: false });
    } else {
      print = { status: row.print_status, message: row.print_message };
    }
    row = this.getTicketRow(res.id);
    const t = this.rowToTicket(row);
    return { duplicate: res.duplicate, ticket: { id: t.id, code: t.code, day: t.day, createdAt: t.createdAt }, print: { status: print.status, message: print.message } };
  }

  /** Označenie, ktoré pacientovi pridelí sestra: 1 – 6 písmen a/alebo číslic (napr. 7, A, AB, K12, 12B). */
  normCard(v) {
    const c = String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '');
    if (!/^[\p{Lu}\d]{1,6}$/u.test(c)) throw bad('Zadajte číslo alebo písmeno pacienta: 1 – 6 písmen a číslic bez medzier a znakov (napr. 7, A, K12).');
    return c;
  }
  /** „HH:MM“ (alebo „H.MM“, „HHMM“) → ISO v UTC pre dnešný deň. null = bez plánovaného času. */
  parsePlanned(v, day) {
    if (v == null || v === '') return null;
    const m = String(v).trim().match(/^(\d{1,2})[:.]?(\d{2})$/);
    if (!m || +m[1] > 23 || +m[2] > 59) throw bad('Plánovaný čas zadajte v tvare HH:MM, napr. 9:30.');
    return clock.localToIso(day, `${m[1].padStart(2, '0')}:${m[2]}`);
  }

  /**
   * v2 – sestra dá pacientovi kartičku s číslom a zaradí ho do zoznamu s plánovaným časom vyšetrenia.
   * Rovnaká kartička nemôže byť v jeden deň súčasne medzi čakajúcimi/vyvolanými dvakrát.
   */
  registerCard(cardNo, plannedTime, userId, roomId) {
    const code = this.normCard(cardNo);
    const day = clock.today();
    const planned = this.parsePlanned(plannedTime, day);
    const home = roomId != null && roomId !== '' ? this.requireRoom(roomId).id : null;
    const id = tx(this.db, () => {
      // označenie musí byť jedinečné naprieč pracoviskami – TV je spoločná
      const dup = this.db.prepare(`SELECT t.code, t.status, h.name AS home FROM tickets t LEFT JOIN rooms h ON h.id = t.home_room_id
        WHERE t.day = ? AND t.code = ? AND t.status IN ('waiting','called')`).get(day, code);
      if (dup) throw conflict(`Označenie ${code} je už v zozname${dup.home ? ` (${dup.home})` : ''} – ${STATUS_TEXT[dup.status]}. Zvoľte iné, alebo najprv pacienta označte ako vybaveného.`);
      const { last_seq: seq } = this.db.prepare(`INSERT INTO day_counters (day, last_seq) VALUES (?, 1)
        ON CONFLICT(day) DO UPDATE SET last_seq = last_seq + 1 RETURNING last_seq`).get(day);
      const now = clock.nowIso();
      const newId = Number(this.db.prepare(`INSERT INTO tickets (day, seq, code, status, created_at, print_status, print_message, planned_at, source, home_room_id)
        VALUES (?, ?, ?, 'waiting', ?, 'disabled', 'Pridelila sestra – bez tlače', ?, 'card', ?)`).run(day, seq, code, now, planned, home).lastInsertRowid);
      this.db.prepare("INSERT INTO ticket_events (ticket_id, type, at, user_id, note) VALUES (?, 'created', ?, ?, 'sestra')").run(newId, now, userId ?? null);
      return newId;
    });
    this.changed('tickets');
    return { ticket: this.getTicket(id) };
  }

  /** Spárovanie / zmena plánovaného času (aj pre čísla z tabletu). */
  setPlanned(ticketId, plannedTime, userId) {
    const row = this.getTicketRow(ticketId);
    this.requireToday(row);
    const planned = this.parsePlanned(plannedTime, row.day);
    tx(this.db, () => {
      this.db.prepare('UPDATE tickets SET planned_at = ?, version = version + 1 WHERE id = ?').run(planned, row.id);
      this.db.prepare("INSERT INTO ticket_events (ticket_id, type, at, user_id, note) VALUES (?, 'planned', ?, ?, ?)")
        .run(row.id, clock.nowIso(), userId ?? null, planned ? String(plannedTime).trim() : 'bez času');
    });
    this.changed('tickets');
    return { ticket: this.getTicket(row.id) };
  }

  /** Tlač lístka; nikdy nevytvára nové číslo. */
  print(ticketId, { reprint, userId } = {}) {
    if (this.printing.has(ticketId)) return this.printing.get(ticketId);
    const p = (async () => {
      const row = this.getTicketRow(ticketId);
      if (!row) throw notFound('Číslo neexistuje.');
      const s = this.getSettings();
      const r = await printer.printTicket(s.printer, {
        code: row.code, createdAt: row.created_at, clinicName: s.clinicName, instruction: s.ticketInstruction, reprint,
      });
      const now = clock.nowIso();
      this.db.prepare(`UPDATE tickets SET print_status = ?, print_message = ?, print_attempts = print_attempts + ?,
        printed_at = CASE WHEN ? IN ('ok','unverified') THEN ? ELSE printed_at END WHERE id = ?`)
        .run(r.status, r.message, r.status === 'disabled' ? 0 : 1, r.status, now, ticketId);
      this.db.prepare('INSERT INTO ticket_events (ticket_id, type, at, user_id, note) VALUES (?, ?, ?, ?, ?)')
        .run(ticketId, reprint ? 'reprint' : 'print', now, userId ?? null, r.status);
      this.changed('print');
      return { status: r.status, message: r.message };
    })().finally(() => this.printing.delete(ticketId));
    this.printing.set(ticketId, p);
    return p;
  }

  async reprint(ticketId, userId) {
    const row = this.getTicketRow(ticketId);
    if (!row) throw notFound('Číslo neexistuje.');
    const print = await this.print(row.id, { reprint: true, userId });
    return { ticket: this.getTicket(row.id), print };
  }

  requireToday(row) {
    if (!row) throw notFound('Číslo neexistuje.');
    if (row.day !== clock.today()) throw conflict(`Číslo ${row.code} je z predchádzajúceho dňa (${row.day}). Staré čísla sa do nového dňa neprenášajú.`);
  }
  requireRoom(roomId) {
    const room = this.getRoom(roomId);
    if (!room || !room.active) throw bad('Vyberte platnú ambulanciu.');
    return room;
  }

  conflictMessage(row) {
    switch (row.status) {
      case 'called': return `Číslo ${row.code} už medzičasom vyvolala iná sestra${row.room_name ? ` (${row.room_name})` : ''}.`;
      case 'done': return `Číslo ${row.code} je už označené ako vybavené.`;
      case 'absent': return `Číslo ${row.code} je označené ako neprítomné.`;
      default: return `Číslo ${row.code} je medzičasom v stave „${STATUS_TEXT[row.status]}“.`;
    }
  }

  emitCall(eventId, ticketId, repeat) {
    const row = this.getTicketRow(ticketId);
    const call = { callId: eventId, code: row.code, roomId: row.room_id, roomName: row.room_name, ...this.roomDisplay(row.room_id), at: row.called_at, repeat };
    this.rev++;
    this.emit('call', call);
    this.changed('tickets');
    return call;
  }

  call(ticketId, roomId, userId, note) {
    const room = this.requireRoom(roomId);
    const cleanNote = note ? str(String(note), 200, 'Poznámka', { allowEmpty: true }) : null;
    const r = tx(this.db, () => {
      const row = this.getTicketRow(ticketId);
      this.requireToday(row);
      const now = clock.nowIso();
      const u = this.db.prepare(`UPDATE tickets SET status = 'called', called_at = ?, call_count = call_count + 1, room_id = ?,
        finished_at = NULL, version = version + 1 WHERE id = ? AND status IN ('waiting','absent')`).run(now, room.id, row.id);
      if (u.changes === 0) throw conflict(this.conflictMessage(row));
      const ev = this.db.prepare("INSERT INTO ticket_events (ticket_id, type, at, room_id, user_id, note) VALUES (?, 'call', ?, ?, ?, ?)")
        .run(row.id, now, room.id, userId ?? null, cleanNote || null);
      return { id: row.id, eventId: Number(ev.lastInsertRowid) };
    });
    this.clearRoomDelay(room.id);
    const call = this.emitCall(r.eventId, r.id, false);
    return { ticket: this.getTicket(r.id), call };
  }

  /** Vyvolá ďalšieho pacienta tohto pracoviska (alebo spoločného, napr. z tabletu). */
  callNext(roomId, userId) {
    const room = this.requireRoom(roomId);
    const r = tx(this.db, () => {
      const row = this.db.prepare(`SELECT id FROM tickets WHERE day = ? AND status = 'waiting' AND (home_room_id = ? OR home_room_id IS NULL)
        ORDER BY COALESCE(planned_at, created_at), seq LIMIT 1`).get(clock.today(), room.id);
      if (!row) throw conflict('Nikto nečaká.');
      const now = clock.nowIso();
      this.db.prepare(`UPDATE tickets SET status = 'called', called_at = ?, call_count = call_count + 1, room_id = ?, version = version + 1
        WHERE id = ? AND status = 'waiting'`).run(now, room.id, row.id);
      const ev = this.db.prepare("INSERT INTO ticket_events (ticket_id, type, at, room_id, user_id) VALUES (?, 'call', ?, ?, ?)").run(row.id, now, room.id, userId ?? null);
      return { id: row.id, eventId: Number(ev.lastInsertRowid) };
    });
    this.clearRoomDelay(room.id);
    const call = this.emitCall(r.eventId, r.id, false);
    return { ticket: this.getTicket(r.id), call };
  }

  // ---------- hlásenie meškania pracoviska (napr. predĺžený výkon) ----------
  setRoomDelay(roomId, minutes, text) {
    const room = this.requireRoom(roomId);
    const s = this.getSettings();
    const d = { ...(s.roomDelays || {}) };
    if (minutes == null || minutes === '' || Number(minutes) === 0) delete d[room.id];
    else d[room.id] = { minutes: clampInt(minutes, 5, 300, 'Meškanie (min)'),
      text: text ? str(String(text), 140, 'Text oznamu', { allowEmpty: true }) : '', at: clock.nowIso() };
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('roomDelays', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(d));
    this.changed('settings');
    return { roomDelays: d };
  }
  clearRoomDelay(roomId) {
    const d = this.getSettings().roomDelays || {};
    if (!d[roomId]) return;
    delete d[roomId];
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('roomDelays', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(d));
  }

  recall(ticketId, roomId, userId) {
    const room = roomId != null ? this.requireRoom(roomId) : null;
    const r = tx(this.db, () => {
      const row = this.getTicketRow(ticketId);
      this.requireToday(row);
      if (row.status !== 'called') throw conflict(`Číslo ${row.code} nie je vyvolané, nemožno ho zopakovať.`);
      const now = clock.nowIso();
      const rid = room ? room.id : row.room_id;
      this.db.prepare('UPDATE tickets SET called_at = ?, call_count = call_count + 1, room_id = ?, version = version + 1 WHERE id = ?').run(now, rid, row.id);
      const ev = this.db.prepare("INSERT INTO ticket_events (ticket_id, type, at, room_id, user_id) VALUES (?, 'recall', ?, ?, ?)").run(row.id, now, rid, userId ?? null);
      return { id: row.id, eventId: Number(ev.lastInsertRowid) };
    });
    const call = this.emitCall(r.eventId, r.id, true);
    return { ticket: this.getTicket(r.id), call };
  }

  transition(ticketId, to, from, userId, evType) {
    const id = tx(this.db, () => {
      const row = this.getTicketRow(ticketId);
      this.requireToday(row);
      if (!from.includes(row.status)) {
        if (row.status === to) throw conflict(`Číslo ${row.code} už je v stave „${STATUS_TEXT[to]}“.`);
        throw conflict(`Číslo ${row.code} je v stave „${STATUS_TEXT[row.status]}“ – túto zmenu nemožno vykonať.`);
      }
      const now = clock.nowIso();
      const finished = to === 'done' || to === 'absent' ? now : null;
      const extra = to === 'waiting' ? ', room_id = NULL, called_at = NULL' : '';
      const u = this.db.prepare(`UPDATE tickets SET status = ?, finished_at = ?, version = version + 1${extra} WHERE id = ? AND status = ?`).run(to, finished, row.id, row.status);
      if (u.changes === 0) throw conflict(this.conflictMessage(row));
      this.db.prepare('INSERT INTO ticket_events (ticket_id, type, at, room_id, user_id) VALUES (?, ?, ?, ?, ?)').run(row.id, evType, now, row.room_id, userId ?? null);
      return row.id;
    });
    this.changed('tickets');
    return { ticket: this.getTicket(id) };
  }
  done(id, userId) { return this.transition(id, 'done', ['waiting', 'called'], userId, 'done'); }
  absent(id, userId) { return this.transition(id, 'absent', ['waiting', 'called'], userId, 'absent'); }
  requeue(id, userId) { return this.transition(id, 'waiting', ['called', 'absent', 'done'], userId, 'requeue'); }

  closeDay(userId) {
    const day = clock.today();
    const n = tx(this.db, () => {
      const rows = this.db.prepare("SELECT id FROM tickets WHERE day = ? AND status IN ('waiting','called')").all(day);
      const now = clock.nowIso();
      for (const r of rows) {
        this.db.prepare("UPDATE tickets SET status = 'absent', finished_at = ?, version = version + 1 WHERE id = ?").run(now, r.id);
        this.db.prepare("INSERT INTO ticket_events (ticket_id, type, at, user_id, note) VALUES (?, 'day_closed', ?, ?, 'ukončenie dňa')").run(r.id, now, userId ?? null);
      }
      // Zrušíme aj zobrazenie posledných vyvolaní na obrazovke.
      const any = this.db.prepare('SELECT id FROM tickets WHERE day = ? ORDER BY id DESC LIMIT 1').get(day);
      if (any) this.db.prepare("INSERT INTO ticket_events (ticket_id, type, at, user_id) VALUES (?, 'display_cleared', ?, ?)").run(any.id, now, userId ?? null);
      return rows.length;
    });
    log.info('Deň bol ukončený', { day, closed: n });
    this.changed('tickets');
    return { day, closed: n };
  }

  purge(scope) {
    const day = clock.today();
    const r = tx(this.db, () => {
      if (scope === 'history') {
        const c = this.db.prepare('DELETE FROM tickets WHERE day < ?').run(day).changes;
        this.db.prepare('DELETE FROM day_counters WHERE day < ?').run(day);
        return c;
      }
      if (scope === 'all') {
        // Počítadlo dnešného dňa ponecháme, aby sa dnes nikdy nezopakovalo už vydané číslo.
        const c = this.db.prepare('DELETE FROM tickets').run().changes;
        this.db.prepare('DELETE FROM day_counters WHERE day < ?').run(day);
        return c;
      }
      throw bad('Neznámy rozsah vymazania.');
    });
    log.info('Údaje boli vymazané', { scope, tickets: r });
    this.changed('tickets');
    return { deleted: r };
  }

  // ---------- pohľady ----------
  counts(day) {
    const c = { waiting: 0, called: 0, done: 0, absent: 0 };
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM tickets WHERE day = ? GROUP BY status').all(day)) c[r.status] = r.n;
    return c;
  }

  listTickets(day) {
    return this.db.prepare('SELECT t.*, r.name AS room_name, h.name AS home_room_name FROM tickets t LEFT JOIN rooms r ON r.id = t.room_id LEFT JOIN rooms h ON h.id = t.home_room_id WHERE t.day = ? ORDER BY t.seq')
      .all(day).map((t) => this.rowToTicket(t));
  }

  displayState() {
    const s = this.getSettings();
    const day = clock.today();
    const evs = this.db.prepare(`SELECT e.id, e.type, e.at, e.ticket_id, e.room_id, t.code, r.name AS room_name FROM ticket_events e
      JOIN tickets t ON t.id = e.ticket_id LEFT JOIN rooms r ON r.id = e.room_id
      WHERE t.day = ? AND e.type IN ('call','recall','requeue','display_cleared') ORDER BY e.id DESC LIMIT 300`).all(day);
    const cancelled = new Set();
    const seen = new Set();
    const list = [];
    const roomCurrent = {};   // v3: posledné vyvolané číslo každej ambulancie („Práve vyšetrujeme“)
    for (const e of evs) {
      if (e.type === 'display_cleared') break; // všetko staršie je zrušené
      if (e.type === 'requeue') { cancelled.add(e.ticket_id); continue; }
      if (cancelled.has(e.ticket_id) || seen.has(e.ticket_id)) continue;
      seen.add(e.ticket_id);
      if (e.room_id != null && !(e.room_id in roomCurrent)) roomCurrent[e.room_id] = { code: e.code, at: e.at };
      if (list.length <= s.recentCount) list.push({ callId: e.id, code: e.code, roomId: e.room_id, roomName: e.room_name, ...this.roomDisplay(e.room_id), at: e.at, repeat: e.type === 'recall' });
    }
    // v2: čísla na rade (len číslo a plánovaný čas – žiadne osobné údaje) a aktuálny sklz ambulancie
    const waiting = this.db.prepare(`SELECT t.code, t.planned_at, t.home_room_id, h.name AS home FROM tickets t LEFT JOIN rooms h ON h.id = t.home_room_id
      WHERE t.day = ? AND t.status = 'waiting' ORDER BY COALESCE(t.planned_at, t.created_at), t.seq`).all(day);
    const last = this.db.prepare(`SELECT e.at, t.planned_at FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id
      WHERE t.day = ? AND e.type = 'call' AND t.planned_at IS NOT NULL ORDER BY e.id DESC LIMIT 1`).get(day);
    const clinicDelayMinutes = last ? Math.round((Date.parse(last.at) - Date.parse(last.planned_at)) / 60000) : 0;
    // v2.1: sklz každého pracoviska zvlášť – podľa jeho posledného vyvolania a hlásenia sestry
    const rooms = this.listRooms({ activeOnly: true }).map((r) => {
      const lr = this.db.prepare(`SELECT e.at, t.planned_at FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id
        WHERE t.day = ? AND e.type = 'call' AND e.room_id = ? AND t.planned_at IS NOT NULL ORDER BY e.id DESC LIMIT 1`).get(day, r.id);
      const rd = (s.roomDelays || {})[r.id];
      return { id: r.id, name: r.name, doctorName: this.doctorsToday()[r.id] || null, direction: r.direction,
        lastCallDelayMinutes: lr ? Math.round((Date.parse(lr.at) - Date.parse(lr.planned_at)) / 60000) : null,
        reported: rd ? { minutes: rd.minutes, text: rd.text || '', at: rd.at } : null,
        current: roomCurrent[r.id] ? roomCurrent[r.id].code : null };
    });
    return {
      clinicName: s.clinicName, soundEnabled: s.soundEnabled, recentCount: s.recentCount, day,
      current: list[0] || null, recent: list.slice(1, 1 + s.recentCount),
      serverTime: clock.nowIso(),
      queue: waiting.slice(0, s.queueCount).map((t) => ({ code: t.code, plannedAt: t.planned_at, roomId: t.home_room_id ?? null, roomName: t.home ?? null,
        doctorName: t.home_room_id != null ? this.doctorsToday()[t.home_room_id] || null : null })),
      rooms, longDelayMinutes: s.longDelayMinutes,
      announcement: this.announcement(),
      waitingCount: waiting.length,
      clinicDelayMinutes, onTimeMinutes: s.onTimeMinutes,
      ticketDisplaySeconds: s.ticketDisplaySeconds,
      tvSource: s.tvSource, newsEnabled: s.news.enabled,
      voice: { enabled: !!(s.soundEnabled && s.voice.enabled), rate: s.voice.rate, room: s.voice.room },
      screen: { title: s.screen.title, address: s.screen.address, phone: s.screen.phone, info: s.screen.info, theme: s.screen.theme,
        tvLabel: s.screen.tvLabel, weatherEnabled: !!s.screen.weather.enabled },
    };
  }

  staffState() {
    const day = clock.today();
    const s = this.getSettings();
    const prev = this.db.prepare(`SELECT day, COUNT(*) AS n FROM tickets WHERE day < ? AND status IN ('waiting','called')
      GROUP BY day ORDER BY day DESC LIMIT 1`).get(day);
    const lp = printer.lastStatus();
    return {
      day, serverTime: clock.nowIso(),
      tickets: this.listTickets(day),
      counts: this.counts(day),
      rooms: this.listRooms(),
      settings: s,
      doctors: this.doctorsToday(),
      announcement: this.announcement(),
      printer: { enabled: s.printer.enabled, lastStatus: lp.status, lastMessage: lp.message, lastCheckedAt: lp.checkedAt },
      previousDayOpen: prev ? { day: prev.day, count: prev.n } : null,
    };
  }

  publicConfig() {
    const s = this.getSettings();
    return { clinicName: s.clinicName, ticketDisplaySeconds: s.ticketDisplaySeconds, soundEnabled: s.soundEnabled,
      recentCount: s.recentCount, printEnabled: s.printer.enabled, ticketInstruction: s.ticketInstruction,
      day: clock.today(), serverTime: clock.nowIso() };
  }

  days() {
    return this.db.prepare(`SELECT day, COUNT(*) AS total,
      SUM(status='waiting') AS waiting, SUM(status='called') AS called, SUM(status='done') AS done, SUM(status='absent') AS absent
      FROM tickets GROUP BY day ORDER BY day DESC LIMIT 400`).all();
  }

  history(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw bad('Neplatný dátum.');
    const events = this.db.prepare(`SELECT e.id, e.ticket_id AS ticketId, t.code, e.type, e.at, r.name AS roomName, e.note
      FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id LEFT JOIN rooms r ON r.id = e.room_id
      WHERE t.day = ? ORDER BY e.id`).all(day);
    return { day, tickets: this.listTickets(day), events };
  }

  /** Kontrola zmeny dňa (volá sa periodicky). */
  tick() {
    const d = clock.today();
    if (d !== this.currentDay) {
      log.info('Nový deň', { from: this.currentDay, to: d });
      this.currentDay = d;
      this.changed('day');
    }
  }

  changed(kind) { this.rev++; this.emit('change', kind); }
}

module.exports = { Store, AppError, DEFAULT_SETTINGS, STATUS_TEXT };
