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
  // 2026-11-17 (Pali): hlasitosť vyvolania na TV v % – signál sa dá zosilniť až na 200 %, hlas prehliadača najviac na 100 %
  soundVolume: 150,
  recentCount: 5,
  // v2 – obrazovka s TV programom
  queueCount: 8,            // koľko čísel „na rade“ ukáže TV
  onTimeMinutes: 3,         // odchýlka ± v minútach, ktorá sa ešte zobrazí ako „načas“
  longDelayMinutes: 30,     // od tohto meškania ukáže TV oznam „predĺžený výkon – ďakujeme za trpezlivosť“
  roomDelays: {},
  // v2.2: zoznam lekárov na výber (sestra môže zadať aj iné meno) – z mamkrcovezily.sk/nas-tim (2026-11-08)
  doctorList: ['MUDr. Pavel Staško, PhD., MHA, MPH', 'MUDr. Adela Czetöová', 'MUDr. Mária Kubíková, PhD.', 'MUDr. Filip Kúdela', 'MUDr. Dominik Kovaľ', 'MUDr. Veronika Roškovičová, PhD.'],           // { [roomId]: { minutes, text, at } } – hlásenie meškania od sestry; zruší sa pri ďalšom vyvolaní z pracoviska
  // 2026-11-17: zdravotné sestry na výber – z mamkrcovezily.sk/nas-tim (sestra môže zadať aj iné meno, napr. externistku)
  nurseList: ['Daniela Fetyková', 'Natália Kopčáková', 'PhDr. Mária Cibuľová', 'Bianka Sotáková'],
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
  voice: { enabled: true, rate: 0.9, room: true, style: 'nahodne' },
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
const STATUS_TEXT = { waiting: 'Čaká', called: 'Vyvolaný', done: 'Ukončený', absent: 'Neprítomný' };

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

/**
 * 2026-11-17 (Pali): typy pacientov v ponuke pri pridaní – zoradené podľa početnosti
 * (najviac pacientov s varixami, najmenej AVF). Na obrazovke v čakárni sa typ neukazuje.
 */
const PATIENT_TYPES = [
  'Vstupné vyšetrenie varixy', 'Kontrola varixy', 'Kontrola po OP varixy', 'Kontrola po CLaCS',
  'Vstupné angio', 'Kontrola angio', 'Kontrola po OP hemoroidy', 'AVF',
  // 2026-11-20 (Pali): nové výkony – v aplikácii Sestra majú modrý štítok
  'Vstup', 'Vstup hemoroidy', 'Kontrola hemoroidy', 'Pooperačná kontrola hemoroidy',
];

class Store extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.rev = 0;
    this.printing = new Map(); // ticketId -> Promise (prebiehajúca tlač)
    this.currentDay = clock.today();
    this.seed();
    this.clearOldStaffNotes();
  }

  seed() {
    const seeded = this.db.prepare("SELECT value FROM settings WHERE key = 'seeded'").get();
    if (seeded) return this.migrate();
    tx(this.db, () => {
      if (!this.db.prepare('SELECT 1 FROM rooms LIMIT 1').get()) {
        const DIR = ['right', 'left', ''];   // AdNa: č. 1 vpravo, č. 2 vľavo
        DEMO_ROOMS.forEach((n, i) => this.db.prepare('INSERT INTO rooms (name, sort_order, direction) VALUES (?, ?, ?)').run(n, i + 1, DIR[i] || ''));
      }
      this.db.prepare("INSERT INTO settings (key, value) VALUES ('seeded', 'true')").run();
    });
  }

  /** Jednorazové úpravy uložených nastavení (každá sa vykoná len raz). */
  migrate() {
    const done = (k) => this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(k);
    const mark = (k) => this.db.prepare("INSERT INTO settings (key, value) VALUES (?, 'true')").run(k);
    // 2026-11-10: nová lekárka v zozname na výber (ak si ho personál už upravil, meno sa doplní na koniec)
    if (!done('mig-2026-11-10-roskovicova')) {
      tx(this.db, () => {
        const row = this.db.prepare("SELECT value FROM settings WHERE key = 'doctorList'").get();
        if (row) {
          let list = []; try { list = JSON.parse(row.value); } catch {}
          if (Array.isArray(list) && !list.some((n) => /Roškovičov/i.test(n))) {
            list.push('MUDr. Veronika Roškovičová, PhD.');
            this.db.prepare("UPDATE settings SET value = ? WHERE key = 'doctorList'").run(JSON.stringify(list));
          }
        }
        mark('mig-2026-11-10-roskovicova');
      });
    }
    // 2026-11-16: konto správcu sa volá „admin“ (predtým „personal“) – heslo aj relácie ostávajú
    if (!done('mig-2026-11-16-personal-na-admin')) {
      tx(this.db, () => {
        if (!this.db.prepare("SELECT 1 FROM users WHERE username = 'admin'").get()) this.db.prepare("UPDATE users SET username = 'admin' WHERE username = 'personal'").run();
        mark('mig-2026-11-16-personal-na-admin');
      });
    }
    // 2026-11-16: kontá lekárov podľa priezviska, zatiaľ BEZ hesla (prihlásiť sa nedá, kým ho správca nenastaví v Nastaveniach → Kontá)
    if (!done('mig-2026-11-16-konta-lekarov')) {
      tx(this.db, () => {
        const login = (full) => {
          const parts = String(full).split(',')[0].replace(/\b(MUDr|MVDr|Mgr|Bc|Ing|doc|prof|PhD|MHA|MPH)\.?/gi, ' ').trim().split(/\s+/);
          return String(parts[parts.length - 1] || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 30);
        };
        for (const name of this.getSettings().doctorList || []) {
          const un = login(name);
          if (un.length < 3) continue;
          if (this.db.prepare('SELECT 1 FROM users WHERE doctor_name = ? OR username = ?').get(name, un)) continue;
          this.db.prepare("INSERT INTO users (username, password_hash, role, created_at, doctor_name) VALUES (?, '!', 'staff', ?, ?)").run(un, clock.nowIso(), name);
          log.info('Vytvorené konto lekára bez hesla', { username: un });
        }
        mark('mig-2026-11-16-konta-lekarov');
      });
    }
    // 2026-11-10: štatistiky lekárov – dnešné vyvolania doplníme o lekára, ktorý je dnes zadaný v ambulancii
    if (!done('mig-2026-11-10-lekar-vo-vyvolani')) {
      tx(this.db, () => {
        const byRoom = this.doctorsToday();
        const upd = this.db.prepare(`UPDATE ticket_events SET doctor = ? WHERE doctor IS NULL AND type IN ('call','recall') AND room_id = ?
          AND ticket_id IN (SELECT id FROM tickets WHERE day = ?)`);
        for (const [roomId, name] of Object.entries(byRoom)) if (name) upd.run(name, Number(roomId), clock.today());
        mark('mig-2026-11-10-lekar-vo-vyvolani');
      });
    }
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
    if ('soundVolume' in patch) next.soundVolume = clampInt(patch.soundVolume, 10, 200, 'Hlasitosť vyvolania (%)');
    if ('recentCount' in patch) next.recentCount = clampInt(patch.recentCount, 0, 10, 'Počet naposledy vyvolaných');
    if ('queueCount' in patch) next.queueCount = clampInt(patch.queueCount, 0, 15, 'Počet čísel na rade');
    if ('doctorList' in patch) {
      if (!Array.isArray(patch.doctorList) || patch.doctorList.length > 40) throw bad('Zoznam lekárov môže mať najviac 40 mien.');
      next.doctorList = [...new Set(patch.doctorList.map((n) => str(String(n), 60, 'Meno lekára', { allowEmpty: true })).filter(Boolean))];
    }
    if ('nurseList' in patch) {
      if (!Array.isArray(patch.nurseList) || patch.nurseList.length > 40) throw bad('Zoznam sestier môže mať najviac 40 mien.');
      next.nurseList = [...new Set(patch.nurseList.map((n) => str(String(n), 60, 'Meno sestry', { allowEmpty: true })).filter(Boolean))];
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
      if ('style' in v) { if (!['nahodne', 'kratke', 'prosimdo', 'nechsapacido', 'prosim', 'nechsapaci', 'pokracujte', 'prid', 'cakame', 'narade', 'ocakava', 'dakujeme', 'dobryden'].includes(v.style)) throw bad('Neznáme znenie hlásenia.'); next.voice.style = v.style; }
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
    this.reopenRoom(room.id);
    this.changed('doctors');
    return { doctors: byRoom };
  }
  // ---------- 2026-11-17 (Pali): sestra, ktorá dnes slúži v ambulancii (zadá sa ráno spolu s lekárom) ----------
  nursesToday() {
    const raw = this.db.prepare("SELECT value FROM settings WHERE key = 'nurses'").get();
    let d = null; try { d = raw ? JSON.parse(raw.value) : null; } catch {}
    return d && d.day === clock.today() ? d.byRoom || {} : {};
  }
  setNurse(roomId, name, userId) {
    const room = this.requireRoom(roomId);
    const n = str(name == null ? '' : String(name), 60, 'Sestra', { allowEmpty: true });
    const byRoom = { ...this.nursesToday() };
    if (n.length === 0) delete byRoom[room.id];
    else if (n.length < 2) throw bad('Zadajte meno sestry.');
    else byRoom[room.id] = n;
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('nurses', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ day: clock.today(), byRoom }));
    log.info('Sestra v ambulancii', { room: room.name, userId });
    this.changed('nurses');
    return { nurses: byRoom };
  }

  // ---------- 2026-11-17 (Pali): „dnes v tejto ambulancii neordinuje nikto“ – ambulancia sa dnes nezobrazuje ----------
  roomsClosedToday() {
    const raw = this.db.prepare("SELECT value FROM settings WHERE key = 'roomsClosed'").get();
    let d = null; try { d = raw ? JSON.parse(raw.value) : null; } catch {}
    return d && d.day === clock.today() && Array.isArray(d.ids) ? d.ids : [];
  }
  saveRoomsClosed(ids) {
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('roomsClosed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ day: clock.today(), ids }));
  }
  setRoomClosed(roomId, closed, userId) {
    const room = this.requireRoom(roomId);
    const ids = this.roomsClosedToday().filter((x) => x !== room.id);
    if (closed) {
      const open = this.listRooms({ activeOnly: true }).filter((r) => r.id !== room.id && !ids.includes(r.id));
      if (!open.length) throw conflict('Aspoň jedna ambulancia musí ordinovať. Keď dnes už nevyšetrujete, použite tlačidlo „Ukončiť deň“.');
      ids.push(room.id);
      // dnešný lekár tejto ambulancie sa zruší, aby sa jeho meno nikde neukazovalo
      const byRoom = { ...this.doctorsToday() };
      const nurses = { ...this.nursesToday() };
      if (room.id in nurses) {
        delete nurses[room.id];
        this.db.prepare("INSERT INTO settings (key, value) VALUES ('nurses', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(JSON.stringify({ day: clock.today(), byRoom: nurses }));
      }
      if (room.id in byRoom) {
        delete byRoom[room.id];
        this.db.prepare("INSERT INTO settings (key, value) VALUES ('doctors', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(JSON.stringify({ day: clock.today(), byRoom }));
      }
    }
    this.saveRoomsClosed(ids);
    log.info(closed ? 'Ambulancia dnes neordinuje' : 'Ambulancia dnes opäť ordinuje', { room: room.name, userId });
    this.changed('rooms');
    return { roomsClosed: ids };
  }
  /** Keď sa do „zatvorenej“ ambulancie zadá lekár alebo z nej niekto vyvolá, dnes zas ordinuje. */
  reopenRoom(roomId) {
    const ids = this.roomsClosedToday();
    if (ids.includes(roomId)) { this.saveRoomsClosed(ids.filter((x) => x !== roomId)); this.changed('rooms'); }
  }

  // ---------- 2026-11-17 (Pali): „Ukončiť deň“ – dnes už nových pacientov neprijímame ----------
  dayEnd() {
    const raw = this.db.prepare("SELECT value FROM settings WHERE key = 'dayEnd'").get();
    let d = null; try { d = raw ? JSON.parse(raw.value) : null; } catch {}
    return d && d.day === clock.today() ? { at: d.at } : null;
  }
  setDayEnd(ended, user) {
    const v = ended ? { day: clock.today(), at: clock.nowIso() } : null;
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('dayEnd', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(v));
    log.info(ended ? 'Príjem pacientov na dnes ukončený' : 'Príjem pacientov opäť otvorený', { user: user && user.username });
    this.changed('dayEnd');
    return { dayEnd: this.dayEnd() };
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

  /** Údaje pre TV o ambulancii: meno lekára a sestry (ak sú zadané) a smer šípky. */
  roomDisplay(roomId) {
    const r = roomId != null ? this.getRoom(roomId) : null;
    if (!r) return { doctorName: null, nurseName: null, direction: '' };
    return { doctorName: this.doctorsToday()[r.id] || null, nurseName: this.nursesToday()[r.id] || null, direction: r.direction };
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
  /**
   * withNote = true len pre prihlásený personál (sestry, lekári, správca): identifikátor a typ pacienta.
   * Obrazovka v čakárni ani tablet ich nikdy nedostanú.
   */
  rowToTicket(t, withNote = false) {
    if (!t) return null;
    const out = {
      id: t.id, code: t.code, day: t.day, seq: t.seq, status: t.status, statusText: STATUS_TEXT[t.status],
      createdAt: t.created_at, calledAt: t.called_at, finishedAt: t.finished_at, callCount: t.call_count,
      roomId: t.room_id, roomName: t.room_name ?? null, version: t.version,
      plannedAt: t.planned_at ?? null, source: t.source || 'kiosk',
      homeRoomId: t.home_room_id ?? null, homeRoomName: t.home_room_name ?? null,
      stage: t.stage || 'nurse', toDoctorAt: t.to_doctor_at ?? null, finalAt: t.final_at ?? null,
      nurseCalledAt: t.nurse_called_at ?? null, // 2026-11-18: kedy pacienta (prvýkrát) vyvolala sestra – zobrazuje sa v rade k lekárovi
      print: { status: t.print_status, message: t.print_message, attempts: t.print_attempts, printedAt: t.printed_at },
    };
    if (withNote) { out.staffNote = t.staff_note ?? null; out.patientType = t.patient_type ?? null; }
    return out;
  }
  getTicketRow(id) {
    return this.db.prepare(`SELECT t.*, r.name AS room_name, h.name AS home_room_name, (SELECT MIN(e.at) FROM ticket_events e WHERE e.ticket_id = t.id AND e.type = 'call' AND (e.stage = 'nurse' OR e.stage IS NULL)) AS nurse_called_at FROM tickets t LEFT JOIN rooms r ON r.id = t.room_id LEFT JOIN rooms h ON h.id = t.home_room_id WHERE t.id = ?`).get(Number(id));
  }
  getTicket(id, withNote = false) { return this.rowToTicket(this.getTicketRow(id), withNote); }

  /** Identifikátor od sestry: voľný text do 60 znakov; prázdny = žiadny. Do logov ani udalostí sa nezapisuje. */
  normStaffNote(v) {
    if (v == null) return null;
    const s = str(String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' '), 60, 'Identifikátor', { allowEmpty: true });
    return s || null;
  }

  /** Identifikátor platí len v deň návštevy – zo starších dní sa vymaže (údaj o pacientovi sa zbytočne neuchováva). */
  clearOldStaffNotes() {
    this.db.prepare('UPDATE tickets SET staff_note = NULL WHERE day < ? AND staff_note IS NOT NULL').run(clock.today());
  }

  /** Typ pacienta z ponuky; prázdny = nezadaný. */
  normPatientType(v) {
    if (v == null || v === '') return null;
    if (!PATIENT_TYPES.includes(v)) throw bad('Neznámy typ pacienta – vyberte ho z ponuky.');
    return v;
  }

  /**
   * 2026-11-17 (Pali): sestra dopíše k číslu identifikátor a/alebo typ pacienta (aj k vyvolanému či ukončenému z dneška).
   * Mení sa len to, čo je v tele požiadavky.
   */
  setStaffNote(ticketId, b, userId) {
    const row = this.getTicketRow(ticketId);
    this.requireToday(row);
    const clean = b && 'staffNote' in b ? this.normStaffNote(b.staffNote) : row.staff_note;
    const type = b && 'patientType' in b ? this.normPatientType(b.patientType) : row.patient_type;
    this.db.prepare('UPDATE tickets SET staff_note = ?, patient_type = ?, version = version + 1 WHERE id = ?').run(clean, type, row.id);
    this.changed('tickets');
    return { ticket: this.getTicket(row.id, true) };
  }

  formatCode(prefix, seq) { return prefix + String(seq).padStart(3, '0'); }

  /** Registrácia pacienta – idempotentná podľa requestId. */
  async register(requestId, deviceId) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) throw bad('Chýba alebo je neplatný identifikátor požiadavky.');
    const dev = typeof deviceId === 'string' ? deviceId.slice(0, 60) : null;
    const settings = this.getSettings();
    const ended = this.dayEnd();
    const res = tx(this.db, () => {
      const ex = this.db.prepare('SELECT id FROM tickets WHERE request_id = ?').get(requestId);
      if (ex) return { id: ex.id, duplicate: true };
      if (ended) throw new AppError(409, 'DAY_ENDED', 'Príjem pacientov je na dnes ukončený. Obráťte sa, prosím, na sestru.');
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
  /** 2026-11-18 (Pali): kam pacient z čakárne ide – 'nurse' = najprv k sestre (predvolené), 'doctor' = rovno k lekárovi. */
  normStage(v) {
    if (v == null || v === '') return 'nurse';
    if (v !== 'nurse' && v !== 'doctor') throw bad('Neznáma voľba – vyberte „k sestre“ alebo „k lekárovi“.');
    return v;
  }

  registerCard(cardNo, plannedTime, userId, roomId, staffNote, patientType, stage) {
    const code = this.normCard(cardNo);
    const stg = this.normStage(stage);
    const note = this.normStaffNote(staffNote);
    const type = this.normPatientType(patientType);
    const day = clock.today();
    const planned = this.parsePlanned(plannedTime, day);
    const home = roomId != null && roomId !== '' ? this.requireRoom(roomId).id : null;
    const id = tx(this.db, () => {
      // označenie musí byť jedinečné naprieč pracoviskami – TV je spoločná
      const dup = this.db.prepare(`SELECT t.code, t.status, h.name AS home FROM tickets t LEFT JOIN rooms h ON h.id = t.home_room_id
        WHERE t.day = ? AND t.code = ? AND t.status IN ('waiting','called')`).get(day, code);
      if (dup) throw conflict(`Označenie ${code} je už v zozname${dup.home ? ` (${dup.home})` : ''} – ${STATUS_TEXT[dup.status]}. Zvoľte iné, alebo najprv pacienta označte ako ukončeného.`);
      const { last_seq: seq } = this.db.prepare(`INSERT INTO day_counters (day, last_seq) VALUES (?, 1)
        ON CONFLICT(day) DO UPDATE SET last_seq = last_seq + 1 RETURNING last_seq`).get(day);
      const now = clock.nowIso();
      const newId = Number(this.db.prepare(`INSERT INTO tickets (day, seq, code, status, created_at, print_status, print_message, planned_at, source, home_room_id, staff_note, patient_type, stage, to_doctor_at)
        VALUES (?, ?, ?, 'waiting', ?, 'disabled', 'Pridelila sestra – bez tlače', ?, 'card', ?, ?, ?, ?, ?)`).run(day, seq, code, now, planned, home, note, type, stg, stg === 'doctor' ? now : null).lastInsertRowid);
      this.db.prepare("INSERT INTO ticket_events (ticket_id, type, at, user_id, note) VALUES (?, 'created', ?, ?, 'sestra')").run(newId, now, userId ?? null);
      if (stg === 'doctor') this.db.prepare("INSERT INTO ticket_events (ticket_id, type, at, room_id, user_id, note) VALUES (?, 'to_doctor', ?, ?, ?, 'bez sestry')").run(newId, now, home, userId ?? null);
      return newId;
    });
    this.changed('tickets');
    return { ticket: this.getTicket(id, true) };
  }

  /**
   * 2026-11-16 (Pali): zmena ambulancie pacienta – napr. keď ho prevezme druhá ambulancia.
   * roomId = null → spoločný pacient (vidia ho všetky ambulancie).
   */
  setHomeRoom(ticketId, roomId, userId, stage) {
    const home = roomId != null && roomId !== '' ? this.requireRoom(roomId) : null;
    if (stage === 'here') return this.fixRoom(ticketId, home, userId);
    const want = stage != null && stage !== '' ? this.normStage(stage) : null;
    tx(this.db, () => {
      const row = this.getTicketRow(ticketId);
      this.requireToday(row);
      if (!['waiting', 'called', 'absent'].includes(row.status)) throw conflict(`Číslo ${row.code} je už ukončené – ambulanciu nemožno zmeniť.`);
      const now = clock.nowIso();
      this.db.prepare('UPDATE tickets SET home_room_id = ?, version = version + 1 WHERE id = ?').run(home ? home.id : null, row.id);
      this.db.prepare("INSERT INTO ticket_events (ticket_id, type, at, room_id, user_id, note) VALUES (?, 'moved', ?, ?, ?, ?)")
        .run(row.id, now, home ? home.id : null, userId ?? null, home ? home.name : 'všetky ambulancie');
      // 2026-11-23 (Pali): zmena ambulancie aj pri vyvolanom pacientovi (u sestry, u lekára, na ukončení) –
      // napr. pacient musí ísť k inému lekárovi. Pacient odíde z ambulancie do čakárne a zaradí sa do radu
      // novej ambulancie (k lekárovi alebo k sestre); poradie k lekárovi si ponechá podľa pôvodného času.
      if (row.status === 'called') {
        const cur = row.stage || 'nurse';
        const stg = want || (cur === 'nurse' ? 'nurse' : 'doctor');
        this.db.prepare(`UPDATE tickets SET status = 'waiting', room_id = NULL, called_at = NULL, final_at = NULL, stage = ?,
          to_doctor_at = CASE WHEN ? = 'doctor' THEN COALESCE(to_doctor_at, ?) ELSE NULL END WHERE id = ?`).run(stg, stg, now, row.id);
        if (stg === 'doctor' && cur === 'nurse') this.insertCallEvent('to_doctor', row.id, now, row.room_id, userId, null, 'nurse');
        if (stg === 'nurse' && cur !== 'nurse') this.db.prepare("INSERT INTO ticket_events (ticket_id, type, at, room_id, user_id) VALUES (?, 'to_nurse', ?, ?, ?)")
          .run(row.id, now, home ? home.id : null, userId ?? null);
      }
    });
    this.changed('tickets');
    return { ticket: this.getTicket(Number(ticketId)) };
  }

  /**
   * 2026-11-23 (Pali): oprava ambulancie – pacient už je (alebo bol) v inej ambulancii, než ukazuje systém.
   * Bez nového zaradenia do radu: zmení sa ambulancia na kartičke, v histórii aj v štatistikách (udalosti
   * aktuálneho kroku – u sestry, alebo u lekára a ukončenie – sa prepíšu na novú ambulanciu a jej dnešného
   * lekára/sestru). Ide aj pri ukončenom a neprítomnom pacientovi z dnešného dňa. Nič sa nemaže.
   */
  fixRoom(ticketId, home, userId) {
    if (!home) throw bad('Vyberte ambulanciu, v ktorej pacient je.');
    tx(this.db, () => {
      const row = this.getTicketRow(ticketId);
      this.requireToday(row);
      if (row.status === 'waiting') throw conflict(`Číslo ${row.code} čaká – ambulanciu zmeňte bez opravy (pacient sa zaradí do jej radu).`);
      const old = row.room_id != null ? this.getRoom(row.room_id) : null;
      const now = clock.nowIso();
      this.db.prepare('UPDATE tickets SET home_room_id = ?, room_id = ?, version = version + 1 WHERE id = ?').run(home.id, home.id, row.id);
      const docStep = (row.stage || 'nurse') !== 'nurse';
      const doc = this.doctorsToday()[home.id] || null, nur = this.nursesToday()[home.id] || null;
      if (docStep) {
        this.db.prepare(`UPDATE ticket_events SET room_id = ?, doctor = COALESCE(?, doctor) WHERE ticket_id = ? AND stage = 'doctor'
          AND type IN ('call','recall','to_doctor')`).run(home.id, doc, row.id);
        this.db.prepare(`UPDATE ticket_events SET room_id = ? WHERE ticket_id = ? AND (stage = 'final' OR type IN ('to_final','final_back'))
          AND type IN ('call','recall','to_final','final_back')`).run(home.id, row.id);
      } else {
        this.db.prepare(`UPDATE ticket_events SET room_id = ?, nurse = COALESCE(?, nurse), doctor = COALESCE(?, doctor) WHERE ticket_id = ?
          AND COALESCE(stage, 'nurse') = 'nurse' AND type IN ('call','recall')`).run(home.id, nur, doc, row.id);
      }
      this.db.prepare("INSERT INTO ticket_events (ticket_id, type, at, room_id, user_id, note) VALUES (?, 'moved', ?, ?, ?, ?)")
        .run(row.id, now, home.id, userId ?? null, `oprava: ${old ? old.name + ' → ' : ''}${home.name}`);
    });
    this.changed('tickets');
    return { ticket: this.getTicket(Number(ticketId)) };
  }

  /**
   * 2026-11-16 (Pali): úprava zadaného pacienta – označenie, čas objednania a ambulancia naraz.
   * Len čakajúci pacient z dnešného dňa; zmenené označenie musí byť jedinečné ako pri zaradení.
   */
  editTicket(ticketId, b, userId) {
    const row0 = this.getTicketRow(ticketId);
    this.requireToday(row0);
    const code = b && 'cardNo' in b ? this.normCard(b.cardNo) : row0.code;
    const planned = b && 'plannedTime' in b ? this.parsePlanned(b.plannedTime, row0.day) : row0.planned_at;
    const home = b && 'roomId' in b ? (b.roomId != null && b.roomId !== '' ? this.requireRoom(b.roomId).id : null) : row0.home_room_id;
    const note = b && 'staffNote' in b ? this.normStaffNote(b.staffNote) : row0.staff_note;
    const type = b && 'patientType' in b ? this.normPatientType(b.patientType) : row0.patient_type;
    const stg = b && 'stage' in b ? this.normStage(b.stage) : null;   // null = bez zmeny
    tx(this.db, () => {
      const row = this.getTicketRow(ticketId);
      if (row.status !== 'waiting') throw conflict(`Číslo ${row.code} je v stave „${STATUS_TEXT[row.status]}“ – upraviť možno len čakajúceho pacienta.`);
      if (code !== row.code) {
        const dup = this.db.prepare(`SELECT t.status, h.name AS home FROM tickets t LEFT JOIN rooms h ON h.id = t.home_room_id
          WHERE t.day = ? AND t.code = ? AND t.id <> ? AND t.status IN ('waiting','called')`).get(row.day, code, row.id);
        if (dup) throw conflict(`Označenie ${code} je už v zozname${dup.home ? ` (${dup.home})` : ''} – ${STATUS_TEXT[dup.status]}. Zvoľte iné.`);
      }
      this.db.prepare('UPDATE tickets SET code = ?, planned_at = ?, home_room_id = ?, staff_note = ?, patient_type = ?, version = version + 1 WHERE id = ?').run(code, planned, home, note, type, row.id);
      const now = clock.nowIso();
      const ev = this.db.prepare('INSERT INTO ticket_events (ticket_id, type, at, room_id, user_id, note) VALUES (?, ?, ?, ?, ?, ?)');
      if (code !== row.code) ev.run(row.id, 'edited', now, null, userId ?? null, `${row.code} → ${code}`);
      if (planned !== row.planned_at) ev.run(row.id, 'planned', now, null, userId ?? null, planned ? String(b.plannedTime).trim() : 'bez času');
      if (home !== row.home_room_id) ev.run(row.id, 'moved', now, home, userId ?? null, home ? this.getRoom(home).name : 'všetky ambulancie');
      // zmena „ide k sestre“ ↔ „ide k lekárovi“: pacient sa presunie do druhého radu čakajúcich
      if (stg && stg !== (row.stage || 'nurse')) {
        this.db.prepare('UPDATE tickets SET stage = ?, to_doctor_at = ? WHERE id = ?').run(stg, stg === 'doctor' ? now : null, row.id);
        ev.run(row.id, stg === 'doctor' ? 'to_doctor' : 'to_nurse', now, home, userId ?? null, stg === 'doctor' ? 'bez sestry' : null);
      }
    });
    this.changed('tickets');
    return { ticket: this.getTicket(Number(ticketId), true) };
  }

  /**
   * 2026-11-16 (Pali): zrušenie chybne zadaného pacienta. Len čakajúci (ešte nevyvolaný) z dnešného dňa;
   * záznam sa odstráni úplne, aby nekazil štatistiky. Označenie sa tým uvoľní.
   */
  cancelTicket(ticketId, userId) {
    const code = tx(this.db, () => {
      const row = this.getTicketRow(ticketId);
      this.requireToday(row);
      if (row.status !== 'waiting') throw conflict(`Číslo ${row.code} je v stave „${STATUS_TEXT[row.status]}“ – zrušiť možno len čakajúceho pacienta.`);
      if (this.db.prepare("SELECT 1 FROM ticket_events WHERE ticket_id = ? AND type IN ('call','recall') LIMIT 1").get(row.id)) {
        throw conflict(`Číslo ${row.code} už bolo vyvolané – namiesto zrušenia ho označte ako neprítomného.`);
      }
      this.db.prepare('DELETE FROM ticket_events WHERE ticket_id = ?').run(row.id);
      this.db.prepare('DELETE FROM tickets WHERE id = ?').run(row.id);
      return row.code;
    });
    log.info('Zrušený chybne zadaný pacient', { code, userId });
    this.changed('tickets');
    return { cancelled: true, code };
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
      case 'done': return `Číslo ${row.code} je už označené ako ukončené.`;
      case 'absent': return `Číslo ${row.code} je označené ako neprítomné.`;
      default: return `Číslo ${row.code} je medzičasom v stave „${STATUS_TEXT[row.status]}“.`;
    }
  }

  emitCall(eventId, ticketId, repeat) {
    const row = this.getTicketRow(ticketId);
    const ev = this.db.prepare('SELECT stage, nurse, doctor FROM ticket_events WHERE id = ?').get(eventId) || {};
    const call = { callId: eventId, code: row.code, roomId: row.room_id, roomName: row.room_name, ...this.callPerson(row.room_id, ev), at: row.called_at, repeat };
    this.rev++;
    this.emit('call', call);
    this.changed('tickets');
    return call;
  }

  /**
   * Kto pacienta volá (pre TV): krok 'nurse' = sestra (meno sestry, ktorá v ambulancii slúžila pri vyvolaní),
   * krok 'doctor' alebo starší záznam bez kroku = lekár. Meno sa berie z udalosti, aby história ostala pravdivá.
   */
  callPerson(roomId, ev) {
    const d = this.roomDisplay(roomId);
    const stage = ev && (ev.stage === 'nurse' || ev.stage === 'final') ? 'nurse' : 'doctor';
    return { direction: d.direction, stage,
      doctorName: stage === 'doctor' ? (ev && ev.doctor) || d.doctorName : null,
      nurseName: stage === 'nurse' ? (ev && ev.nurse) || d.nurseName : null };
  }

  /** Zápis vyvolania – s krokom a menami sestry a lekára, ktorí sú dnes v ambulancii. */
  insertCallEvent(type, ticketId, at, roomId, userId, note, stage) {
    return Number(this.db.prepare('INSERT INTO ticket_events (ticket_id, type, at, room_id, user_id, note, doctor, nurse, stage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ticketId, type, at, roomId, userId ?? null, note || null, (roomId != null && this.doctorsToday()[roomId]) || null,
        (roomId != null && this.nursesToday()[roomId]) || null, stage).lastInsertRowid);
  }

  /**
   * Vyvolanie konkrétneho čísla. Krok sa berie z čísla (k sestre / k lekárovi). byDoctor = vyvoláva lekárske konto:
   * pacienta, ktorý ešte nebol u sestry, si lekár berie rovno k sebe.
   */
  call(ticketId, roomId, userId, note, { byDoctor = false } = {}) {
    const room = this.requireRoom(roomId);
    const cleanNote = note ? str(String(note), 200, 'Poznámka', { allowEmpty: true }) : null;
    const r = tx(this.db, () => {
      const row = this.getTicketRow(ticketId);
      this.requireToday(row);
      const now = clock.nowIso();
      const stage = byDoctor ? 'doctor' : row.stage || 'nurse';
      const u = this.db.prepare(`UPDATE tickets SET status = 'called', called_at = ?, call_count = call_count + 1, room_id = ?, stage = ?,
        finished_at = NULL, version = version + 1 WHERE id = ? AND status IN ('waiting','absent')`).run(now, room.id, stage, row.id);
      if (u.changes === 0) throw conflict(this.conflictMessage(row));
      return { id: row.id, eventId: this.insertCallEvent('call', row.id, now, room.id, userId, cleanNote, stage) };
    });
    this.clearRoomDelay(room.id);
    this.reopenRoom(room.id);
    const call = this.emitCall(r.eventId, r.id, false);
    return { ticket: this.getTicket(r.id), call };
  }

  /**
   * Vyvolá ďalšieho pacienta tohto pracoviska (alebo spoločného, napr. z tabletu).
   * stage 'nurse' = rad k sestre (podľa termínu/príchodu), 'doctor' = rad k lekárovi (podľa toho, kedy ho sestra poslala).
   */
  callNext(roomId, userId, stage = 'nurse') {
    const room = this.requireRoom(roomId);
    if (!['nurse', 'doctor'].includes(stage)) throw bad('Neznámy krok vyvolania.');
    const r = tx(this.db, () => {
      const row = stage === 'doctor'
        ? this.db.prepare(`SELECT id FROM tickets WHERE day = ? AND status = 'waiting' AND stage = 'doctor' AND (home_room_id = ? OR home_room_id IS NULL)
            ORDER BY COALESCE(to_doctor_at, created_at), seq LIMIT 1`).get(clock.today(), room.id)
        : this.db.prepare(`SELECT id FROM tickets WHERE day = ? AND status = 'waiting' AND stage = 'nurse' AND (home_room_id = ? OR home_room_id IS NULL)
            ORDER BY COALESCE(planned_at, created_at), seq LIMIT 1`).get(clock.today(), room.id);
      if (!row) throw conflict(stage === 'doctor' ? 'Na lekára nikto nečaká.' : 'Nikto nečaká.');
      const now = clock.nowIso();
      this.db.prepare(`UPDATE tickets SET status = 'called', called_at = ?, call_count = call_count + 1, room_id = ?, version = version + 1
        WHERE id = ? AND status = 'waiting'`).run(now, room.id, row.id);
      return { id: row.id, eventId: this.insertCallEvent('call', row.id, now, room.id, userId, null, stage) };
    });
    this.clearRoomDelay(room.id);
    this.reopenRoom(room.id);
    const call = this.emitCall(r.eventId, r.id, false);
    return { ticket: this.getTicket(r.id), call };
  }

  /**
   * 2026-11-17 (Pali): sestra po vyšetrení pošle pacienta k lekárovi.
   * direct = false: pacient ide von do čakárne a zaradí sa do radu lekára tej istej ambulancie (lekár ho vyvolá, TV ukáže lekára).
   * direct = true: pacient ide k lekárovi hneď, bez čakania – ostáva v ambulancii, TV nič nehlási.
   */
  sendToDoctor(ticketId, userId, direct = false) {
    const id = tx(this.db, () => {
      const row = this.getTicketRow(ticketId);
      this.requireToday(row);
      if (row.status !== 'called' || (row.stage || 'nurse') !== 'nurse') {
        if (row.stage === 'doctor') throw conflict(`Číslo ${row.code} už je u lekára alebo naňho čaká.`);
        if (row.stage === 'final') throw conflict(`Číslo ${row.code} už bolo u lekára a je u sestry na ukončenie.`);
        throw conflict(`Číslo ${row.code} nie je u sestry (stav „${STATUS_TEXT[row.status]}“) – k lekárovi ho pošlete po vyvolaní.`);
      }
      const now = clock.nowIso();
      if (direct) {
        this.db.prepare("UPDATE tickets SET stage = 'doctor', to_doctor_at = ?, called_at = ?, home_room_id = COALESCE(room_id, home_room_id), version = version + 1 WHERE id = ?")
          .run(now, now, row.id);
        this.insertCallEvent('to_doctor', row.id, now, row.room_id, userId, 'priamo', 'doctor');
      } else {
        this.db.prepare(`UPDATE tickets SET status = 'waiting', stage = 'doctor', to_doctor_at = ?, home_room_id = COALESCE(room_id, home_room_id),
          room_id = NULL, called_at = NULL, version = version + 1 WHERE id = ?`).run(now, row.id);
        this.insertCallEvent('to_doctor', row.id, now, row.room_id, userId, null, 'nurse');
      }
      return row.id;
    });
    this.changed('tickets');
    return { ticket: this.getTicket(id) };
  }

  /**
   * 2026-11-18 (Pali): lekár po vyšetrení pošle pacienta späť k sestre na ukončenie (platba, papiere).
   * Pacient ostáva „vyvolaný“ (je v ambulancii), TV nič nehlási; „Ukončený“ potvrdí až sestra.
   */
  sendToFinal(ticketId, userId) {
    const id = tx(this.db, () => {
      const row = this.getTicketRow(ticketId);
      this.requireToday(row);
      if (row.status !== 'called' || row.stage !== 'doctor') {
        if (row.stage === 'final' && row.status === 'called') throw conflict(`Číslo ${row.code} už je u sestry na ukončenie.`);
        throw conflict(`Číslo ${row.code} nie je u lekára – k sestre na ukončenie ho pošlete po vyvolaní lekárom.`);
      }
      const now = clock.nowIso();
      this.db.prepare("UPDATE tickets SET stage = 'final', final_at = ?, version = version + 1 WHERE id = ?").run(now, row.id);
      this.insertCallEvent('to_final', row.id, now, row.room_id, userId, null, 'final');
      return row.id;
    });
    this.changed('tickets');
    return { ticket: this.getTicket(id) };
  }
  /** Omyl: pacient z „ukončenia u sestry“ späť k lekárovi (ostáva vyvolaný). */
  backToDoctor(ticketId, userId) {
    const id = tx(this.db, () => {
      const row = this.getTicketRow(ticketId);
      this.requireToday(row);
      if (row.status !== 'called' || row.stage !== 'final') throw conflict(`Číslo ${row.code} nie je u sestry na ukončenie.`);
      const now = clock.nowIso();
      this.db.prepare("UPDATE tickets SET stage = 'doctor', final_at = NULL, version = version + 1 WHERE id = ?").run(row.id);
      this.insertCallEvent('final_back', row.id, now, row.room_id, userId, null, 'doctor');
      return row.id;
    });
    this.changed('tickets');
    return { ticket: this.getTicket(id) };
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
      return { id: row.id, eventId: this.insertCallEvent('recall', row.id, now, rid, userId, null, row.stage || 'nurse') };
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
      const extra = to === 'waiting' ? `, room_id = NULL, called_at = NULL${row.stage === 'final' ? ", stage = 'doctor', final_at = NULL" : ''}` : '';
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

  /** Uzavrie neukončené čísla staršieho dňa (čakajúce a vyvolané → Neprítomný). Dnešok sa uzatvára cez closeDay. */
  closePastDay(day, userId) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw bad('Neplatný dátum.');
    if (day >= clock.today()) throw bad('Dnešný deň sa ukončuje v Nastaveniach (Ukončiť deň).');
    const n = tx(this.db, () => {
      const rows = this.db.prepare("SELECT id FROM tickets WHERE day = ? AND status IN ('waiting','called')").all(day);
      const now = clock.nowIso();
      for (const r of rows) {
        // finished_at ostáva prázdny – čas „ukončenia“ by skreslil štatistiky
        this.db.prepare("UPDATE tickets SET status = 'absent', version = version + 1 WHERE id = ?").run(r.id);
        this.db.prepare("INSERT INTO ticket_events (ticket_id, type, at, user_id, note) VALUES (?, 'day_closed', ?, ?, 'dodatočné uzavretie dňa')").run(r.id, now, userId ?? null);
      }
      return rows.length;
    });
    log.info('Uzavreté neukončené čísla staršieho dňa', { day, closed: n });
    this.changed('tickets');
    return { day, closed: n };
  }

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

  listTickets(day, withNote = false) {
    return this.db.prepare(`SELECT t.*, r.name AS room_name, h.name AS home_room_name, (SELECT MIN(e.at) FROM ticket_events e WHERE e.ticket_id = t.id AND e.type = 'call' AND (e.stage = 'nurse' OR e.stage IS NULL)) AS nurse_called_at FROM tickets t LEFT JOIN rooms r ON r.id = t.room_id LEFT JOIN rooms h ON h.id = t.home_room_id WHERE t.day = ? ORDER BY t.seq`)
      .all(day).map((t) => this.rowToTicket(t, withNote));
  }

  displayState() {
    // Sklz ambulancie pri vyvolaní: od termínu, ale pacient, ktorý prišiel neskoro, sa počíta až od príchodu –
    // jeho meškanie nie je meškanie ambulancie a nesmie sa pripísať ostatným čakajúcim.
    const callDelay = (r) => Math.round((Date.parse(r.at) - Math.max(Date.parse(r.planned_at), Date.parse(r.created_at) || 0)) / 60000);
    const s = this.getSettings();
    const day = clock.today();
    const evs = this.db.prepare(`SELECT e.id, e.type, e.at, e.ticket_id, e.room_id, e.stage, e.nurse, e.doctor, t.code, t.status, r.name AS room_name FROM ticket_events e
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
      // po „ukončený“ (alebo „neprišiel“) ambulancia nikoho nevyšetruje – staré číslo z „Práve vyšetrujeme“ zmizne
      if (e.room_id != null && !(e.room_id in roomCurrent)) roomCurrent[e.room_id] = e.status === 'called' ? { code: e.code, at: e.at, ticketId: e.ticket_id } : null;
      if (list.length <= s.recentCount) list.push({ callId: e.id, code: e.code, roomId: e.room_id, roomName: e.room_name, ...this.callPerson(e.room_id, e), at: e.at, repeat: e.type === 'recall' });
    }
    // v2: čísla na rade (len číslo a plánovaný čas – žiadne osobné údaje) a aktuálny sklz ambulancie
    const waiting = this.db.prepare(`SELECT t.code, t.planned_at, t.created_at, t.home_room_id, h.name AS home FROM tickets t LEFT JOIN rooms h ON h.id = t.home_room_id
      WHERE t.day = ? AND t.status = 'waiting' AND t.stage = 'nurse' ORDER BY COALESCE(t.planned_at, t.created_at), t.seq`).all(day);
    // 2026-11-17: pacienti, ktorých sestra poslala von a čakajú na lekára (na TV bez času – termín platí pre sestru)
    const forDoctor = this.db.prepare(`SELECT t.code, t.home_room_id FROM tickets t WHERE t.day = ? AND t.status = 'waiting' AND t.stage = 'doctor'
      ORDER BY COALESCE(t.to_doctor_at, t.created_at), t.seq`).all(day);
    const last = this.db.prepare(`SELECT e.at, t.planned_at, t.created_at FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id
      WHERE t.day = ? AND e.type = 'call' AND COALESCE(e.stage, 'nurse') = 'nurse' AND t.planned_at IS NOT NULL ORDER BY e.id DESC LIMIT 1`).get(day);
    const clinicDelayMinutes = last ? callDelay(last) : 0;
    // v2.1: sklz každého pracoviska zvlášť – podľa jeho posledného vyvolania a hlásenia sestry
    const closed = this.roomsClosedToday();
    const stageOf = (id) => { const st = (this.db.prepare('SELECT stage FROM tickets WHERE id = ?').get(id) || {}).stage || 'nurse'; return st === 'final' ? 'doctor' : st; };   // 2026-11-18 (Pali): ukončenie u sestry je interný pohyb – na TV ostáva lekár
    const rooms = this.listRooms({ activeOnly: true }).map((r) => {
      const lr = this.db.prepare(`SELECT e.at, t.planned_at, t.created_at FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id
        WHERE t.day = ? AND e.type = 'call' AND COALESCE(e.stage, 'nurse') = 'nurse' AND e.room_id = ? AND t.planned_at IS NOT NULL ORDER BY e.id DESC LIMIT 1`).get(day, r.id);
      const rd = (s.roomDelays || {})[r.id];
      return { id: r.id, name: r.name, doctorName: this.doctorsToday()[r.id] || null, nurseName: this.nursesToday()[r.id] || null, direction: r.direction,
        doctorQueue: forDoctor.filter((t) => t.home_room_id === r.id || t.home_room_id == null).map((t) => t.code),
        lastCallDelayMinutes: lr ? callDelay(lr) : null,
        reported: rd ? { minutes: rd.minutes, text: rd.text || '', at: rd.at } : null,
        current: roomCurrent[r.id] ? roomCurrent[r.id].code : null, calledToday: r.id in roomCurrent,
        closedToday: closed.includes(r.id),
        // 2026-11-17: u koho je pacient práve teraz (sestra / lekár) – podľa kroku čísla, aj po „Priamo k lekárovi“
        currentStage: roomCurrent[r.id] ? stageOf(roomCurrent[r.id].ticketId) : null };
    });
    return {
      clinicName: s.clinicName, soundEnabled: s.soundEnabled, recentCount: s.recentCount, day,
      current: list[0] || null, recent: list.slice(1, 1 + s.recentCount),
      serverTime: clock.nowIso(),
      queue: waiting.slice(0, s.queueCount).map((t) => ({ code: t.code, plannedAt: t.planned_at, arrivedAt: t.created_at, roomId: t.home_room_id ?? null, roomName: t.home ?? null,
        doctorName: t.home_room_id != null ? this.doctorsToday()[t.home_room_id] || null : null })),
      rooms, longDelayMinutes: s.longDelayMinutes,
      announcement: this.announcement(),
      dayEnd: this.dayEnd(),
      waitingCount: waiting.length, doctorQueueCount: forDoctor.length,
      soundVolume: s.soundVolume,
      clinicDelayMinutes, onTimeMinutes: s.onTimeMinutes,
      ticketDisplaySeconds: s.ticketDisplaySeconds,
      tvSource: s.tvSource, newsEnabled: s.news.enabled,
      voice: { enabled: !!(s.soundEnabled && s.voice.enabled), rate: s.voice.rate, room: s.voice.room, style: s.voice.style || 'nahodne' },
      screen: { title: s.screen.title, address: s.screen.address, phone: s.screen.phone, info: s.screen.info, theme: s.screen.theme,
        tvLabel: s.screen.tvLabel, weatherEnabled: !!s.screen.weather.enabled },
    };
  }

  /** withNote: identifikátor a typ pacienta – len pre prihlásený personál (nikdy pre obrazovku či tablet). */
  staffState({ withNote = false } = {}) {
    const day = clock.today();
    const s = this.getSettings();
    const prev = this.db.prepare(`SELECT day, COUNT(*) AS n FROM tickets WHERE day < ? AND status IN ('waiting','called')
      GROUP BY day ORDER BY day DESC LIMIT 1`).get(day);
    const lp = printer.lastStatus();
    return {
      day, serverTime: clock.nowIso(),
      tickets: this.listTickets(day, withNote),
      patientTypes: PATIENT_TYPES,
      counts: this.counts(day),
      rooms: this.listRooms(),
      settings: s,
      doctors: this.doctorsToday(),
      nurses: this.nursesToday(),
      announcement: this.announcement(),
      roomsClosed: this.roomsClosedToday(),
      dayEnd: this.dayEnd(),
      printer: { enabled: s.printer.enabled, lastStatus: lp.status, lastMessage: lp.message, lastCheckedAt: lp.checkedAt },
      previousDayOpen: prev ? { day: prev.day, count: prev.n } : null,
    };
  }

  publicConfig() {
    const s = this.getSettings();
    return { clinicName: s.clinicName, ticketDisplaySeconds: s.ticketDisplaySeconds, soundEnabled: s.soundEnabled,
      recentCount: s.recentCount, printEnabled: s.printer.enabled, ticketInstruction: s.ticketInstruction, dayEnded: !!this.dayEnd(),
      day: clock.today(), serverTime: clock.nowIso() };
  }

  days() {
    return this.db.prepare(`SELECT day, COUNT(*) AS total,
      SUM(status='waiting') AS waiting, SUM(status='called') AS called, SUM(status='done') AS done, SUM(status='absent') AS absent
      FROM tickets GROUP BY day ORDER BY day DESC LIMIT 400`).all();
  }

  history(day, withNote = false) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw bad('Neplatný dátum.');
    const events = this.db.prepare(`SELECT e.id, e.ticket_id AS ticketId, t.code, e.type, e.at, r.name AS roomName, e.note, e.stage, e.nurse, e.doctor
      FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id LEFT JOIN rooms r ON r.id = e.room_id
      WHERE t.day = ? ORDER BY e.id`).all(day);
    return { day, tickets: this.listTickets(day, withNote), events };
  }

  /**
   * Štatistiky za obdobie (len pre správcu). groupBy: 'doctor' | 'nurse' | 'room'.
   *
   * Od 17. 11. 2026 má návšteva dva kroky (Pali): najprv sestra (plánovaný čas = vstup k sestre), potom lekár.
   * – sestra / ambulancia: čakanie = vyvolanie k sestre − príchod, meškanie = vyvolanie k sestre − termín (nie skôr ako príchod),
   *   čas u sestry = poslanie k lekárovi (alebo ukončenie) − vyvolanie k sestre;
   * – lekár: čakanie = vyvolanie lekárom − poslanie od sestry (priamo k lekárovi = 0), vyšetrenie = ukončenie − začiatok u lekára.
   *   Meškanie oproti termínu sa lekárovi pri dvoch krokoch nepripisuje (termín je čas vstupu k sestre).
   * Staršie záznamy (jeden krok, bez kroku v udalosti) sa počítajú ako doteraz: všetko lekárovi z posledného vyvolania.
   */
  doctorStats(from, to, groupBy = 'doctor') {
    const D = /^\d{4}-\d{2}-\d{2}$/;
    if (!D.test(String(from || '')) || !D.test(String(to || '')) || from > to) throw bad('Neplatné obdobie.');
    const tickets = this.db.prepare(`SELECT id, day, status, created_at, planned_at, finished_at, to_doctor_at FROM tickets
      WHERE day BETWEEN ? AND ? AND call_count > 0`).all(from, to);
    const evs = this.db.prepare(`SELECT e.ticket_id, e.type, e.at, e.doctor, e.nurse, e.stage, e.note, r.name AS room FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id
      LEFT JOIN rooms r ON r.id = e.room_id WHERE t.day BETWEEN ? AND ? AND e.type IN ('call','recall','to_doctor','to_nurse','to_final','final_back') ORDER BY e.id`).all(from, to);
    const byT = new Map();
    for (const e of evs) {
      const x = byT.get(e.ticket_id) || { first: null, lastCall: null, doctor: null, nurse: null, room: null, twoStep: false,
        nurseCall: null, sent: null, direct: false, doctorStart: null, final: null };
      if (e.stage) x.twoStep = true;
      if (e.type === 'to_final') {
        x.final = e.at;   // lekár skončil, pacient ide k sestre na ukončenie – čas u lekára sa počíta potiaľto
      } else if (e.type === 'final_back') {
        x.final = null;
      } else if (e.stage === 'final') {
        // zopakované vyvolanie počas ukončenia u sestry – do časov sestry ani lekára nevstupuje
      } else if (e.type === 'to_nurse') {
        x.sent = null;   // sestra voľbu „k lekárovi“ vrátila späť – čakanie na lekára sa od nej nepočíta
      } else if (e.type === 'to_doctor') {
        x.sent = e.at;
        if (e.note === 'priamo') { x.direct = true; if (!x.doctorStart) x.doctorStart = e.at; if (e.doctor) x.doctor = e.doctor; }
        if (e.nurse) x.nurse = e.nurse;
      } else {
        if (!x.first) x.first = e.at;
        if (e.type === 'call') x.lastCall = e.at;
        if (e.stage === 'nurse') { if (!x.nurseCall) x.nurseCall = e.at; if (e.nurse) x.nurse = e.nurse; }
        if (e.stage === 'doctor' && e.type === 'call' && !x.doctorStart) x.doctorStart = e.at;
        if (e.stage === 'doctor' && e.type === 'call') x.final = null;   // nové vyvolanie lekárom (napr. po zmene ambulancie)
        // lekár: pri dvoch krokoch len z vyvolania lekárom, inak z posledného vyvolania (ako doteraz)
        if (e.doctor && (!e.stage || e.stage === 'doctor')) x.doctor = e.doctor;
      }
      if (e.room) x.room = e.room;
      byT.set(e.ticket_id, x);
    }
    const UNKNOWN = groupBy === 'nurse' ? 'Sestra nebola zadaná' : 'Lekár nebol zadaný';
    const groups = new Map();
    const g = (name) => {
      if (!groups.has(name)) groups.set(name, { doctor: name, patients: 0, done: 0, absent: 0, open: 0, days: new Set(), rooms: new Set(),
        waits: [], delays: [], exams: [], onTime: 0, late15: 0, nurseTimes: [], doctorWaits: [], doctorTimes: [], direct: 0, toDoctor: 0 });
      return groups.get(name);
    };
    const min = (a, b) => (Date.parse(a) - Date.parse(b)) / 60000;
    const ok = (m) => m >= 0 && m < 8 * 60;
    const all = g('__spolu__');
    for (const t of tickets) {
      const x = byT.get(t.id);
      if (!x || !x.first) continue;
      const two = x.twoStep;
      // v štatistike lekára sú len pacienti, ktorí k nemu prišli (pri dvoch krokoch); v štatistike sestier len dvojkrokové návštevy
      if (groupBy === 'doctor' && two && !x.doctorStart) continue;
      if (groupBy === 'nurse' && !(two && x.nurseCall)) continue;
      const key = groupBy === 'room' ? x.room || 'Neznáma ambulancia' : groupBy === 'nurse' ? x.nurse || UNKNOWN : x.doctor || UNKNOWN;
      const visitStart = two ? x.nurseCall || x.first : x.first;   // vstup do ambulancie (k sestre)
      for (const s of [g(key), all]) {
        s.patients++;
        if (t.status === 'done') s.done++; else if (t.status === 'absent') s.absent++; else s.open++;
        s.days.add(t.day); if (x.room) s.rooms.add(x.room);
        // čas u sestry, čakanie na lekára a čas u lekára (pri dvoch krokoch)
        if (two && x.nurseCall) { const nt = min(x.sent || (t.status === 'done' ? t.finished_at : null) || x.nurseCall, x.nurseCall); if (ok(nt) && (x.sent || t.status === 'done')) s.nurseTimes.push(nt); }
        if (two && x.sent) s.toDoctor++;
        if (two && x.direct) s.direct++;
        if (two && x.doctorStart) {
          const dw = x.direct ? 0 : x.sent ? min(x.doctorStart, x.sent) : null; if (dw != null && ok(dw)) s.doctorWaits.push(dw);
          { const end = x.final || (t.status === 'done' ? t.finished_at : null); if (end) { const dt = min(end, x.doctorStart); if (ok(dt)) s.doctorTimes.push(dt); } }
        }
        const doctorView = groupBy === 'doctor' && two;
        // čakanie: lekár = na lekára, ostatní = od príchodu po vstup k sestre
        if (doctorView) { const dw = x.direct ? 0 : x.sent ? min(x.doctorStart, x.sent) : null; if (dw != null && dw >= 0) s.waits.push(dw); }
        else { const w = min(visitStart, t.created_at); if (w >= 0) s.waits.push(w); }
        if (t.planned_at && !doctorView) {
          const d = (Date.parse(visitStart) - Math.max(Date.parse(t.planned_at), Date.parse(t.created_at) || 0)) / 60000;
          s.delays.push(d);
          if (d <= 5) s.onTime++;
          if (d > 15) s.late15++;
        }
        // trvanie: lekár = u lekára, sestra = u sestry, ambulancia = celá návšteva od vstupu k sestre
        if (groupBy === 'nurse') { if (two && x.nurseCall && (x.sent || t.status === 'done')) { const nt = min(x.sent || t.finished_at, x.nurseCall); if (ok(nt)) s.exams.push(nt); } }
        else if (doctorView && x.final) { const ex = min(x.final, x.doctorStart); if (ok(ex)) s.exams.push(ex); }
        else if (t.status === 'done' && t.finished_at) {
          const start = doctorView ? x.doctorStart : two ? visitStart : x.lastCall;
          if (start) { const ex = min(t.finished_at, start); if (ok(ex)) s.exams.push(ex); }
        }
      }
    }
    const avg = (a) => (a.length ? Math.round(a.reduce((p, c) => p + c, 0) / a.length) : null);
    const median = (a) => { if (!a.length) return null; const b = [...a].sort((p, q) => p - q); const m = b.length >> 1; return Math.round(b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2); };
    const out = (s) => ({ doctor: s.doctor, patients: s.patients, done: s.done, absent: s.absent, open: s.open, days: s.days.size, rooms: [...s.rooms],
      avgWait: avg(s.waits), medianWait: median(s.waits), maxWait: s.waits.length ? Math.round(Math.max(...s.waits)) : null,
      planned: s.delays.length, avgDelay: avg(s.delays.map((d) => Math.max(0, d))), maxDelay: s.delays.length ? Math.round(Math.max(0, ...s.delays)) : null,
      onTime: s.onTime, late15: s.late15, avgExam: avg(s.exams), medianExam: median(s.exams),
      avgNurse: avg(s.nurseTimes), avgDoctorWait: avg(s.doctorWaits), avgDoctor: avg(s.doctorTimes), toDoctor: s.toDoctor, direct: s.direct });
    const doctors = [...groups.values()].filter((s) => s !== all).map(out)
      .sort((a, b) => (a.doctor === UNKNOWN) - (b.doctor === UNKNOWN) || b.patients - a.patients || a.doctor.localeCompare(b.doctor, 'sk'));
    const since = this.db.prepare("SELECT MIN(t.day) AS d FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id WHERE e.doctor IS NOT NULL").get();
    const twoSince = this.db.prepare("SELECT MIN(t.day) AS d FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id WHERE e.stage IS NOT NULL").get();
    return { from, to, groupBy, doctors, total: out(all), doctorDataSince: since?.d || null, twoStepSince: twoSince?.d || null };
  }

  /** Dnešný prehľad pre sestry: celé zariadenie a jednotlivé ambulancie (bez mien lekárov a bez histórie). */
  todayStats() {
    const day = clock.today();
    const r = this.doctorStats(day, day, 'room');
    const strip = (d) => ({ name: d.doctor, patients: d.patients, done: d.done, absent: d.absent, open: d.open, avgWait: d.avgWait, maxWait: d.maxWait,
      planned: d.planned, avgDelay: d.avgDelay, maxDelay: d.maxDelay, onTime: d.onTime, late15: d.late15, avgExam: d.avgExam,
      avgNurse: d.avgNurse, avgDoctorWait: d.avgDoctorWait, avgDoctor: d.avgDoctor, toDoctor: d.toDoctor, direct: d.direct });
    const waiting = this.db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE day = ? AND status = 'waiting'").get(day).n;
    return { day, total: strip(r.total), rooms: r.doctors.map(strip).sort((a, b) => a.name.localeCompare(b.name, 'sk')), waiting };
  }

  /** Prehľad jedného lekára: súhrn za obdobie a po dňoch (pre lekárske konto). */
  doctorOwnStats(name, from, to) {
    const all = this.doctorStats(from, to);
    const span = (Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86400000;
    if (span > 92) throw bad('Obdobie môže mať najviac 3 mesiace.');
    const pick = (r) => r.doctors.find((d) => d.doctor === name) || null;
    const days = [];
    for (let i = 0; i <= span; i++) {
      const day = new Date(Date.parse(from + 'T12:00:00Z') + i * 86400000).toISOString().slice(0, 10);
      const d = pick(this.doctorStats(day, day));
      if (d) days.push({ day, ...d });
    }
    // Porovnanie s ostatnými lekármi BEZ mien a ambulancií – poradie podľa meškania, aby sa z neho nedalo uhádnuť, o koho ide.
    const anon = (d) => ({ patients: d.patients, done: d.done, avgWait: d.avgWait, planned: d.planned, avgDelay: d.avgDelay, onTime: d.onTime, avgExam: d.avgExam,
      avgDoctorWait: d.avgDoctorWait, avgDoctor: d.avgDoctor });
    const me = pick(all);
    const rows = all.doctors.filter((d) => d.doctor !== 'Lekár nebol zadaný').map((d) => ({ ...anon(d), me: d.doctor === name }))
      .sort((a, b) => (a.avgDelay ?? 1e9) - (b.avgDelay ?? 1e9) || (a.avgWait ?? 1e9) - (b.avgWait ?? 1e9) || b.patients - a.patients);
    let k = 0;
    const comparison = rows.map((r, i) => ({ ...r, rank: i + 1, label: r.me ? 'Vy' : `Lekár ${String.fromCharCode(65 + k++)}` }));
    return { from, to, doctor: name, summary: me, days: days.reverse(), clinic: all.total, comparison };
  }

  /** Kontrola zmeny dňa (volá sa periodicky). */
  tick() {
    const d = clock.today();
    if (d !== this.currentDay) {
      log.info('Nový deň', { from: this.currentDay, to: d });
      this.currentDay = d;
      this.clearOldStaffNotes();
      this.changed('day');
    }
  }

  changed(kind) { this.rev++; this.emit('change', kind); }
}

module.exports = { Store, AppError, DEFAULT_SETTINGS, STATUS_TEXT, PATIENT_TYPES };
