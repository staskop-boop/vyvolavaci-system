'use strict';
// Jednorazové doplnenie novej lekárky do už uloženého zoznamu lekárov na výber.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { Store } = require('../src/store');

test('uložený zoznam lekárov dostane Roškovičovú raz; zmazaná sa znova nevráti', () => {
  const db = open(':memory:');
  let s = new Store(db);
  assert.ok(s.getSettings().doctorList.some((n) => /Roškovičová/.test(n)), 'predvolený zoznam ju obsahuje');
  s.updateSettings({ doctorList: ['MUDr. A', 'MUDr. B'] });
  db.prepare("DELETE FROM settings WHERE key = 'mig-2026-11-10-roskovicova'").run();   // stav pred aktualizáciou
  s = new Store(db);
  assert.deepEqual(s.getSettings().doctorList, ['MUDr. A', 'MUDr. B', 'MUDr. Veronika Roškovičová, PhD.']);
  s.updateSettings({ doctorList: ['MUDr. A'] });
  s = new Store(db);
  assert.deepEqual(s.getSettings().doctorList, ['MUDr. A'], 'po zmazaní personálom sa už nedopĺňa');
});
