'use strict';
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('staff','admin')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  label        TEXT
);
CREATE TABLE IF NOT EXISTS day_counters (
  day      TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  day            TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  code           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','called','done','absent')),
  created_at     TEXT NOT NULL,
  called_at      TEXT,
  call_count     INTEGER NOT NULL DEFAULT 0,
  room_id        INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  finished_at    TEXT,
  request_id     TEXT UNIQUE,
  device_id      TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  print_status   TEXT NOT NULL DEFAULT 'pending',
  print_message  TEXT,
  print_attempts INTEGER NOT NULL DEFAULT 0,
  printed_at     TEXT,
  UNIQUE (day, seq)
);
CREATE INDEX IF NOT EXISTS idx_tickets_day_status ON tickets(day, status);
CREATE TABLE IF NOT EXISTS ticket_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  type      TEXT NOT NULL,
  at        TEXT NOT NULL,
  room_id   INTEGER,
  user_id   INTEGER,
  note      TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ticket ON ticket_events(ticket_id);
CREATE INDEX IF NOT EXISTS idx_events_type_at ON ticket_events(type, at);
`;

function open(file = config.dbFile) {
  if (file !== ':memory:') fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = FULL;');   // spoľahlivé uloženie aj pri výpadku napájania
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  try { ostryStart(db, file); } catch (e) { console.error('⚠ Vymazanie údajov spred ostrej prevádzky zlyhalo – nič sa nezmazalo:', e.message); }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  return db;
}

/**
 * 2026-11-23 (Pali): „od dnes ideme naostro“ – staré štatistiky skresľujú výsledok, preto sa pri prvom spustení tejto verzie
 * jednorazovo zmažú pacienti, história a počítadlá spred 23. 11. 2026. Dnešok a všetko novšie ostáva, kontá a nastavenia tiež.
 * Pred zmazaním sa urobí záloha do <dáta>/zalohy/adna-pred-ostrym-startom-<čas>.db; ak sa záloha nepodarí, nič sa nezmaže.
 */
const OSTRY_START = '2026-11-23';
function ostryStart(db, file, cutoff = OSTRY_START) {
  const key = `ostryStart:${cutoff}`;
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key)) return null;
  const n = db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE day < ?').get(cutoff).n;
  let zaloha = null;
  if (n > 0) {
    if (file !== ':memory:') {
      const path = require('node:path');
      const dir = path.join(path.dirname(file), 'zalohy');
      fs.mkdirSync(dir, { recursive: true });
      zaloha = path.join(dir, `adna-pred-ostrym-startom-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
      db.exec(`VACUUM INTO '${zaloha.replace(/'/g, "''")}'`);
      const z = new DatabaseSync(zaloha, { readOnly: true });
      const vZalohe = z.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;
      z.close();
      if (vZalohe !== db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n) throw new Error('záloha nesedí s databázou');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM ticket_events WHERE ticket_id IN (SELECT id FROM tickets WHERE day < ?)').run(cutoff);
      db.prepare('DELETE FROM tickets WHERE day < ?').run(cutoff);
      db.prepare('DELETE FROM day_counters WHERE day < ?').run(cutoff);
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify({ at: new Date().toISOString(), deleted: n, backup: zaloha }));
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    console.log(`Ostrá prevádzka od ${cutoff}: zmazaných ${n} starších pacientov (záloha: ${zaloha || '—'}).`);
  } else {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify({ at: new Date().toISOString(), deleted: 0 }));
  }
  return { deleted: n, backup: zaloha };
}

/** v2: plánovaný čas vyšetrenia a zdroj čísla (tablet / kartička od sestry). Bezpečné aj pri opakovanom spustení. */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
  if (!cols.includes('planned_at')) db.exec('ALTER TABLE tickets ADD COLUMN planned_at TEXT');
  if (!cols.includes('source')) db.exec("ALTER TABLE tickets ADD COLUMN source TEXT NOT NULL DEFAULT 'kiosk'");
  // v2.1: pracovisko, ktorému pacient patrí (ambulancia sestry, ktorá ho zaradila); null = spoločné (napr. z tabletu)
  // 2026-11-17 (Pali): identifikátor pacienta, ktorý si k číslu dopíše sestra (meno, poznámka…).
  // Vidí ho personál (sestry, lekári, správca) – nikdy TV ani tablet. Po skončení dňa sa vymaže.
  if (!cols.includes('staff_note')) db.exec('ALTER TABLE tickets ADD COLUMN staff_note TEXT');
  // 2026-11-17 (Pali): typ pacienta (napr. Vstupné vyšetrenie varixy) – vyberá sestra, na TV sa neukazuje
  if (!cols.includes('patient_type')) db.exec('ALTER TABLE tickets ADD COLUMN patient_type TEXT');
  // 2026-11-17 (Pali): dva kroky – pacient ide najprv k sestre (plánovaný čas = vstup k sestre), potom ho volá lekár.
  // stage = 'nurse' (čaká na sestru / je u sestry) | 'doctor' (čaká na lekára / je u lekára); to_doctor_at = kedy ho sestra poslala k lekárovi
  if (!cols.includes('stage')) db.exec("ALTER TABLE tickets ADD COLUMN stage TEXT NOT NULL DEFAULT 'nurse'");
  // 2026-11-18: stage 'final' = po lekárovi späť u sestry na ukončenie (platba, papiere); final_at = kedy ho lekár poslal
  if (!cols.includes('final_at')) db.exec('ALTER TABLE tickets ADD COLUMN final_at TEXT');
  if (!cols.includes('to_doctor_at')) db.exec('ALTER TABLE tickets ADD COLUMN to_doctor_at TEXT');
  if (!cols.includes('home_room_id')) db.exec('ALTER TABLE tickets ADD COLUMN home_room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL');
  // v2.2: smer k ambulancii zo stredu čakárne (šípka na TV): right | left | straight | ''
  const rcols = db.prepare('PRAGMA table_info(rooms)').all().map((c) => c.name);
  if (!rcols.includes('direction')) {
    db.exec("ALTER TABLE rooms ADD COLUMN direction TEXT NOT NULL DEFAULT ''");
    // AdNa: Ambulancia č. 1 je vpravo, Ambulancia č. 2 vľavo (Pali 2026-11-08) – dá sa zmeniť v Nastaveniach
    db.exec("UPDATE rooms SET direction = 'right' WHERE name LIKE 'Ambulancia č. 1%'");
    db.exec("UPDATE rooms SET direction = 'left' WHERE name LIKE 'Ambulancia č. 2%'");
  }
  // v3.2: lekár, ktorý ordinoval pri vyvolaní (pre štatistiky – zoznam lekárov v nastaveniach nie je historický)
  const ecols = db.prepare('PRAGMA table_info(ticket_events)').all().map((c) => c.name);
  if (!ecols.includes('doctor')) db.exec('ALTER TABLE ticket_events ADD COLUMN doctor TEXT');
  // 2026-11-17: krok vyvolania (nurse | doctor; staršie záznamy NULL = jeden krok) a sestra, ktorá v ambulancii slúžila
  if (!ecols.includes('stage')) db.exec('ALTER TABLE ticket_events ADD COLUMN stage TEXT');
  if (!ecols.includes('nurse')) db.exec('ALTER TABLE ticket_events ADD COLUMN nurse TEXT');
  const ucols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  // v2.1: konto sestry je priradené k pracovisku (ambulancii); null = všetky pracoviská
  if (!ucols.includes('room_id')) db.exec('ALTER TABLE users ADD COLUMN room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL');
  // v3.3: konto lekára – vyvoláva pacientov, nepridáva ich; meno sa zhoduje s menom na TV a v štatistikách
  if (!ucols.includes('doctor_name')) db.exec('ALTER TABLE users ADD COLUMN doctor_name TEXT');
  // 2026-11-24 (Pali): osobné konto sestry – štatistiky sa viažu na sestru, ktorá je prihlásená, nie na ambulanciu
  if (!ucols.includes('nurse_name')) db.exec('ALTER TABLE users ADD COLUMN nurse_name TEXT');
}

/** Vykoná funkciu v transakcii BEGIN IMMEDIATE (zápisový zámok hneď na začiatku). */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

module.exports = { open, tx, SCHEMA };
