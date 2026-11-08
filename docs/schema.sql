-- Databázová schéma AdNa (SQLite). Server ju vytvorí automaticky pri prvom spustení.
-- Zdroj pravdy: server/src/db.js
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
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

-- Ukážkové nastavenie troch ambulancií (server ho vloží automaticky pri prvom spustení):
-- INSERT INTO rooms (name, sort_order) VALUES ('Ambulancia č. 1', 1), ('Ambulancia č. 2', 2), ('USG pracovisko', 3);
