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

test('migrácia: konto personal sa premenuje na admin, heslo ostáva a staré meno sa dá ešte použiť', () => {
  const { Auth } = require('../src/auth');
  const db = open(':memory:');
  const s1 = new Store(db); s1.seed();
  const auth = new Auth(db);
  auth.createOrResetUser('personal', 'Testovacie-heslo-1', 'admin');
  db.prepare("DELETE FROM settings WHERE key = 'mig-2026-11-16-personal-na-admin'").run();
  new Store(db).seed();
  assert.deepEqual(db.prepare('SELECT username, role FROM users WHERE doctor_name IS NULL').all().map((u) => ({ ...u })), [{ username: 'admin', role: 'admin' }]);
  assert.ok(auth.login('admin', 'Testovacie-heslo-1', '1.1.1.1').token);
  assert.ok(auth.login('personal', 'Testovacie-heslo-1', '1.1.1.1').token, 'staré meno funguje ako alias');
});
