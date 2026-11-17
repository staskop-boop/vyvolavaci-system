'use strict';
// 2026-11-17: lekárka sa nevedela prihlásiť – meno s diakritikou, konto bez hesla a blokácia celej ambulancie
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { freshDataDir, start, client, setupAndLogin } = require('./helpers');

freshDataDir();
let s, admin;
before(async () => { s = await start(); admin = await setupAndLogin(s); });
after(() => s.close());

const login = (username, password) => client(s.base).post('/api/auth/login', { username, password });
const HESLO = 'Heslo-lekarky-01';

test('lekárske konto bez hesla: jasná správa, nie blokácia', async () => {
  // také konto vytvorí migrácia pre lekárov zo zoznamu (heslo nastaví správca)
  s.db.prepare("INSERT INTO users (username, password_hash, role, created_at, doctor_name) VALUES ('czetoova', '!', 'staff', ?, 'MUDr. Adela Czetöová')").run(new Date().toISOString());
  for (let i = 0; i < 7; i++) {
    const r = await login('czetoova', 'hocijake-heslo-1');
    assert.equal(r.status, 401);
    assert.match(r.data.error.message, /nemá nastavené heslo/);
  }
});

test('meno s diakritikou, veľkými písmenami aj celým menom lekára', async () => {
  const u = (await admin.get('/api/admin/users')).data.users.find((x) => x.username === 'czetoova');
  assert.equal((await admin.put('/api/admin/users/' + u.id, { password: HESLO })).status, 200);
  for (const n of ['czetoova', 'Czetöová', ' CZETÖOVÁ ', 'MUDr. Adela Czetöová']) {
    const r = await login(n, HESLO);
    assert.equal(r.status, 200, n);
    assert.equal(r.data.user.doctorName, 'MUDr. Adela Czetöová');
  }
});

test('preklepy jedného konta neblokujú ostatných ani správne heslo po pauze', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login('ambulancia1', 'zle-heslo-12345')).status, 401);
  const locked = await login('ambulancia1', 'zle-heslo-12345');
  assert.equal(locked.status, 429);
  assert.match(locked.data.error.message, /ambulancia1/);
  // lekárka z tej istej ambulancie (tá istá IP) sa prihlási normálne
  assert.equal((await login('Czetöová', HESLO)).status, 200);
  assert.equal((await login('admin', 'Testovacie-heslo-1')).status, 200);
});

test('celkový limit z jednej IP ostáva (hádanie cez veľa mien)', async () => {
  const codes = [];
  for (let i = 0; i < 20; i++) codes.push((await login('neexistuje' + i, 'zle-heslo-12345')).status);
  assert.ok(codes.includes(429), 'po 20 chybách z jednej IP nasleduje pauza');
  assert.equal((await login('admin', 'Testovacie-heslo-1')).status, 429);
});

test('krátke nové heslo pri úprave konta neuloží nič (ani ostatné zmeny)', async () => {
  const u = (await admin.get('/api/admin/users')).data.users.find((x) => x.username === 'czetoova');
  const r = await admin.put('/api/admin/users/' + u.id, { password: 'kratke', active: false });
  assert.equal(r.status, 400);
  assert.equal((await admin.get('/api/admin/users')).data.users.find((x) => x.id === u.id).active, true);
});
