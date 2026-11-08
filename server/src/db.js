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
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  return db;
}

/** v2: plánovaný čas vyšetrenia a zdroj čísla (tablet / kartička od sestry). Bezpečné aj pri opakovanom spustení. */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
  if (!cols.includes('planned_at')) db.exec('ALTER TABLE tickets ADD COLUMN planned_at TEXT');
  if (!cols.includes('source')) db.exec("ALTER TABLE tickets ADD COLUMN source TEXT NOT NULL DEFAULT 'kiosk'");
  // v2.1: pracovisko, ktorému pacient patrí (ambulancia sestry, ktorá ho zaradila); null = spoločné (napr. z tabletu)
  if (!cols.includes('home_room_id')) db.exec('ALTER TABLE tickets ADD COLUMN home_room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL');
  // v2.2: smer k ambulancii zo stredu čakárne (šípka na TV): right | left | straight | ''
  const rcols = db.prepare('PRAGMA table_info(rooms)').all().map((c) => c.name);
  if (!rcols.includes('direction')) {
    db.exec("ALTER TABLE rooms ADD COLUMN direction TEXT NOT NULL DEFAULT ''");
    // AdNa: Ambulancia č. 1 je vpravo, Ambulancia č. 2 vľavo (Pali 2026-11-08) – dá sa zmeniť v Nastaveniach
    db.exec("UPDATE rooms SET direction = 'right' WHERE name LIKE 'Ambulancia č. 1%'");
    db.exec("UPDATE rooms SET direction = 'left' WHERE name LIKE 'Ambulancia č. 2%'");
  }
  const ucols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  // v2.1: konto sestry je priradené k pracovisku (ambulancii); null = všetky pracoviská
  if (!ucols.includes('room_id')) db.exec('ALTER TABLE users ADD COLUMN room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL');
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
