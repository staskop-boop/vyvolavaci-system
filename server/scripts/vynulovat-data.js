'use strict';
// Vynulovanie testovacích údajov pred ostrou prevádzkou (Pali 2026-11-16).
//   node scripts/vynulovat-data.js --potvrdit
// Zmaže: pacientov (čísla), históriu vyvolaní, štatistiky (sú počítané z histórie), denné počítadlá čísel
// a hlásenia meškania ambulancií. Ponechá: kontá a heslá, prihlásenia, ambulancie, lekárov, nastavenia
// obrazovky a vzhľadu, mimoriadny oznam.
// Pred zmazaním vždy urobí zálohu databázy do <dáta>/zalohy/adna-pred-vynulovanim-<čas>.db.
// Skript je samostatný (len node:sqlite), aby sa dal spustiť aj cez stdin v kontajneri: node - --potvrdit
// Server má byť počas behu skriptu vypnutý (inak by zobrazoval staré čísla až do reštartu).
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

function vynulovat(dataDir) {
  const dbFile = path.join(dataDir, 'adna.db');
  if (!fs.existsSync(dbFile)) throw new Error(`Databáza ${dbFile} neexistuje.`);
  const db = new DatabaseSync(dbFile);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    const pocet = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    const pred = { pacienti: pocet('tickets'), udalosti: pocet('ticket_events'), dni: pocet('day_counters') };

    const zalohy = path.join(dataDir, 'zalohy');
    fs.mkdirSync(zalohy, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zaloha = path.join(zalohy, `adna-pred-vynulovanim-${stamp}.db`);
    db.exec(`VACUUM INTO '${zaloha.replace(/'/g, "''")}'`);
    // kontrola zálohy: musí sa dať otvoriť a mať rovnaký počet pacientov
    const z = new DatabaseSync(zaloha, { readOnly: true });
    const vZalohe = z.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;
    z.close();
    if (vZalohe !== pred.pacienti) throw new Error('Záloha nesedí s databázou – nič som nezmazal.');

    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM ticket_events');
      db.exec('DELETE FROM tickets');
      db.exec('DELETE FROM day_counters');
      db.exec("DELETE FROM sqlite_sequence WHERE name IN ('tickets', 'ticket_events')");
      db.exec("DELETE FROM settings WHERE key = 'roomDelays'");
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const po = {
      pacienti: pocet('tickets'), udalosti: pocet('ticket_events'), dni: pocet('day_counters'),
      konta: pocet('users'), ambulancie: pocet('rooms'), nastavenia: pocet('settings'),
    };
    return { pred, po, zaloha };
  } finally {
    db.close();
  }
}

module.exports = { vynulovat };

if (require.main === module || process.argv[1] === '-') {
  if (!process.argv.includes('--potvrdit')) {
    console.error('⚠ Vynulovanie je nevratné (okrem zálohy). Spustite s prepínačom --potvrdit.');
    process.exit(2);
  }
  const dataDir = path.resolve(process.env.ADNA_DATA_DIR || path.join(__dirname, '..', 'data'));
  try {
    const r = vynulovat(dataDir);
    console.log(`Záloha: ${r.zaloha}`);
    console.log(`Pred vynulovaním: pacienti ${r.pred.pacienti}, záznamy histórie ${r.pred.udalosti}, dni s počítadlom ${r.pred.dni}`);
    console.log(`Po vynulovaní:    pacienti ${r.po.pacienti}, záznamy histórie ${r.po.udalosti}, dni s počítadlom ${r.po.dni}`);
    console.log(`Ponechané:        kontá ${r.po.konta}, ambulancie ${r.po.ambulancie}, nastavenia ${r.po.nastavenia}`);
  } catch (e) {
    console.error('⚠ Vynulovanie zlyhalo:', e.message);
    process.exit(1);
  }
}
