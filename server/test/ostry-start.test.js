'use strict';
// 2026-11-23 (Pali): od dnes naostro – pri prvom spustení sa jednorazovo zmažú údaje spred 23. 11. 2026 (so zálohou), dnešok ostane.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const dataDir = h.freshDataDir();
const { DatabaseSync } = require('node:sqlite');
const dbm = require('../src/db');
const file = path.join(dataDir, 'adna.db');

test('staré dni sa zmažú raz, so zálohou; dnešok, kontá a nastavenia ostanú', () => {
  let db = dbm.open(file);
  db.exec("DELETE FROM settings WHERE key LIKE 'ostryStart:%'");   // stav servera pred touto verziou
  db.exec("INSERT INTO settings (key, value) VALUES ('clinicName', '\"AdNa test\"')");
  const ins = db.prepare("INSERT INTO tickets (day, seq, code, status, created_at) VALUES (?, ?, ?, 'done', ?)");
  const ev = db.prepare("INSERT INTO ticket_events (ticket_id, type, at) VALUES (?, 'call', ?)");
  for (const [day, seq] of [['2026-11-17', 1], ['2026-11-20', 1], ['2026-11-22', 1], ['2026-11-23', 1], ['2026-11-23', 2], ['2026-11-24', 1]]) {
    const id = ins.run(day, seq, 'A' + seq, day + 'T08:00:00.000Z').lastInsertRowid;
    ev.run(id, day + 'T08:05:00.000Z');
    db.prepare('INSERT OR REPLACE INTO day_counters (day, last_seq) VALUES (?, ?)').run(day, seq);
  }
  db.close();

  db = dbm.open(file);
  const days = () => db.prepare('SELECT DISTINCT day FROM tickets ORDER BY day').all().map((r) => r.day);
  assert.deepEqual(days(), ['2026-11-23', '2026-11-24']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ticket_events').get().n, 3);
  assert.deepEqual(db.prepare('SELECT day FROM day_counters ORDER BY day').all().map((r) => r.day), ['2026-11-23', '2026-11-24']);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'clinicName'").get().value, '"AdNa test"');
  const zalohy = fs.readdirSync(path.join(dataDir, 'zalohy')).filter((f) => f.startsWith('adna-pred-ostrym-startom-'));
  assert.equal(zalohy.length, 1);
  const z = new DatabaseSync(path.join(dataDir, 'zalohy', zalohy[0]), { readOnly: true });
  assert.equal(z.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 6, 'záloha má všetko');
  z.close();

  // druhé spustenie už nič nemaže – ani keby sa starý deň objavil znova
  db.prepare("INSERT INTO tickets (day, seq, code, status, created_at) VALUES ('2026-11-01', 1, 'X1', 'done', '2026-11-01T08:00:00.000Z')").run();
  db.close();
  db = dbm.open(file);
  assert.deepEqual(days(), ['2026-11-01', '2026-11-23', '2026-11-24']);
  assert.equal(fs.readdirSync(path.join(dataDir, 'zalohy')).length, 1);
  db.close();
});
