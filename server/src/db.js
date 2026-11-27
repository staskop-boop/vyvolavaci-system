'use strict';
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const SCHEMA_VERSION = 3;

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

/**
 * v3 (2026-11-27, Pali): platba pacienta a pokladničný doklad vo VRP2 Finančnej správy SR.
 * Nové tabuľky sa iba pridávajú – staré návštevy nedostanú platbu ani úlohu na doklad (payments je na začiatku prázdna).
 * Ostrá pokladnica sa nasadením nikdy nezapne: cash_registers.mode je predvolene 'sim' a zapnúť 'live' môže len správca.
 */
const SCHEMA_POKLADNICA = `
CREATE TABLE IF NOT EXISTS billing_companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  ico TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS vrp_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  status_json TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS cash_registers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES billing_companies(id),
  label TEXT NOT NULL,
  vrp_code TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'sim' CHECK (mode IN ('sim','live')),
  agent_id INTEGER REFERENCES vrp_agents(id) ON DELETE SET NULL,
  printer_name TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  live_since TEXT,
  live_by INTEGER
);
CREATE TABLE IF NOT EXISTS room_registers (
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  register_id INTEGER NOT NULL REFERENCES cash_registers(id) ON DELETE CASCADE,
  PRIMARY KEY (room_id, register_id)
);
CREATE TABLE IF NOT EXISTS price_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES billing_companies(id),
  vrp_name TEXT NOT NULL,
  vrp_code TEXT NOT NULL DEFAULT '',
  price_cents INTEGER CHECK (price_cents IS NULL OR (price_cents >= 0 AND price_cents <= 10000000)),
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, vrp_name)
);
CREATE TABLE IF NOT EXISTS procedures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS procedure_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  procedure_id INTEGER NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,
  variant TEXT NOT NULL DEFAULT '' CHECK (variant IN ('','one','both')),
  price_item_id INTEGER NOT NULL REFERENCES price_items(id),
  qty INTEGER NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 9999),
  UNIQUE (procedure_id, variant)
);
-- Platba návštevy: nemenná kópia spoločnosti, pokladnice, položiek, cien a platidla + samostatné stavy dokladu.
-- ticket_id UNIQUE = jedna platba na návštevu; op_id UNIQUE = idempotencia potvrdenia (dvojklik, obnovenie stránky).
-- Bez cudzieho kľúča na tickets: záznam o prijatej platbe sa nesmie zmazať ani pri vymazaní histórie poradia.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE,
  ticket_id INTEGER NOT NULL UNIQUE,
  ticket_day TEXT NOT NULL,
  ticket_code TEXT NOT NULL,
  company_id INTEGER NOT NULL, company_name TEXT NOT NULL, company_ico TEXT NOT NULL,
  register_id INTEGER NOT NULL, register_label TEXT NOT NULL, register_code TEXT NOT NULL,
  register_mode TEXT NOT NULL CHECK (register_mode IN ('sim','live')),
  room_id INTEGER, room_name TEXT NOT NULL,
  items_json TEXT NOT NULL,
  total_cents INTEGER NOT NULL, rounding_cents INTEGER NOT NULL, payable_cents INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash','card')),
  received_cents INTEGER, change_cents INTEGER, card_confirmed INTEGER NOT NULL DEFAULT 0,
  confirmed_by INTEGER, confirmed_by_name TEXT, confirmed_at TEXT NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'received' CHECK (payment_status IN ('received')),
  receipt_status TEXT NOT NULL DEFAULT 'queued'
    CHECK (receipt_status IN ('queued','claimed','submitting','issued','needs_session','mismatch','failed','unverified')),
  attempt INTEGER NOT NULL DEFAULT 1,
  claim_token TEXT, claimed_at TEXT, claimed_by_agent INTEGER, submit_started_at TEXT,
  receipt_id TEXT, receipt_number TEXT, receipt_issued_at TEXT, receipt_simulated INTEGER,
  last_error TEXT, version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(receipt_status, register_id);
CREATE INDEX IF NOT EXISTS idx_payments_day ON payments(ticket_day);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_receipt ON payments(register_code, receipt_id) WHERE receipt_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS payments_snapshot_immutable BEFORE UPDATE ON payments
WHEN NEW.op_id IS NOT OLD.op_id OR NEW.ticket_id IS NOT OLD.ticket_id OR NEW.items_json IS NOT OLD.items_json
  OR NEW.total_cents IS NOT OLD.total_cents OR NEW.rounding_cents IS NOT OLD.rounding_cents OR NEW.payable_cents IS NOT OLD.payable_cents
  OR NEW.method IS NOT OLD.method OR NEW.received_cents IS NOT OLD.received_cents OR NEW.change_cents IS NOT OLD.change_cents
  OR NEW.company_id IS NOT OLD.company_id OR NEW.company_name IS NOT OLD.company_name OR NEW.company_ico IS NOT OLD.company_ico
  OR NEW.register_id IS NOT OLD.register_id OR NEW.register_code IS NOT OLD.register_code OR NEW.register_mode IS NOT OLD.register_mode
  OR NEW.room_id IS NOT OLD.room_id OR NEW.room_name IS NOT OLD.room_name OR NEW.confirmed_by IS NOT OLD.confirmed_by
  OR NEW.confirmed_at IS NOT OLD.confirmed_at OR NEW.payment_status IS NOT OLD.payment_status
BEGIN SELECT RAISE(ABORT, 'Údaje potvrdenej platby sú nemenné.'); END;
-- vydaný doklad sa nedá prepísať ani „zabudnúť“
CREATE TRIGGER IF NOT EXISTS payments_receipt_immutable BEFORE UPDATE ON payments
WHEN OLD.receipt_status = 'issued' AND (NEW.receipt_status IS NOT 'issued' OR NEW.receipt_id IS NOT OLD.receipt_id OR NEW.receipt_simulated IS NOT OLD.receipt_simulated)
BEGIN SELECT RAISE(ABORT, 'Vydaný doklad sa nedá zmeniť.'); END;
-- po začatom odoslaní do VRP2 sa úloha nesmie potichu vrátiť do fronty (to by mohlo vydať druhý doklad);
-- nový pokus je možný len ako vedomé rozhodnutie správcu (attempt + 1) po kontrole evidencie VRP2
CREATE TRIGGER IF NOT EXISTS payments_no_blind_retry BEFORE UPDATE ON payments
WHEN OLD.submit_started_at IS NOT NULL AND NEW.receipt_status IN ('queued','claimed','needs_session') AND NEW.attempt = OLD.attempt
BEGIN SELECT RAISE(ABORT, 'Odoslanie do VRP2 sa už začalo – úlohu nemožno automaticky zopakovať.'); END;
CREATE TRIGGER IF NOT EXISTS payments_no_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'Záznam o platbe sa nemaže.'); END;
CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  from_status TEXT, to_status TEXT,
  user_id INTEGER, user_name TEXT, agent_id INTEGER,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_payment_events ON payment_events(payment_id);
CREATE TABLE IF NOT EXISTS print_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER,
  register_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('original','copy','test')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','sent','printed','failed')),
  claim_token TEXT, claimed_at TEXT, finished_at TEXT,
  created_at TEXT NOT NULL, created_by INTEGER,
  message TEXT
);
CREATE INDEX IF NOT EXISTS idx_print_jobs ON print_jobs(status, register_id);
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
  db.exec(SCHEMA_POKLADNICA);
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

module.exports = { open, tx, SCHEMA, SCHEMA_POKLADNICA };
