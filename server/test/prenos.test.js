'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const h = require('./helpers');
h.freshDataDir();

let s, admin;
before(async () => { s = await h.start(); admin = await h.setupAndLogin(s); });
after(() => s.close());

test('zálohu databázy stiahne len správca', async () => {
  assert.equal((await fetch(s.base + '/api/admin/backup')).status, 401);
  await admin.post('/api/admin/users', { username: 'sestra1', password: 'Sestra-heslo-01' });
  const sestra = h.client(s.base);
  await sestra.post('/api/auth/login', { username: 'sestra1', password: 'Sestra-heslo-01' });
  assert.equal((await sestra.get('/api/admin/backup')).status, 403);
});

test('prenos: skript stiahne celistvú databázu s kontami a po sebe nenechá dočasné súbory', async () => {
  const { stiahnut } = require('../scripts/stiahnut-zalohu');
  const ciel = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adna-prenos-')), 'prenos.db');
  const r = await stiahnut({ zdroj: s.base + '/', meno: 'admin', heslo: 'Testovacie-heslo-1', ciel });
  assert.equal(r.konta, 2);
  const db = new DatabaseSync(ciel);
  assert.deepEqual(db.prepare('SELECT username FROM users ORDER BY id').all().map((u) => u.username), ['admin', 'sestra1']);
  db.close();
  const cfg = require('../src/config');
  assert.deepEqual(fs.readdirSync(cfg.dataDir).filter((f) => f.startsWith('prenos-')), [], 'dočasná záloha na serveri sa zmaže');
});

test('prenos: zlé heslo, konto bez práv a server ukazujúci sám na seba skončia zrozumiteľnou chybou', async () => {
  const { stiahnut } = require('../scripts/stiahnut-zalohu');
  const ciel = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adna-prenos-')), 'prenos.db');
  await assert.rejects(stiahnut({ zdroj: s.base, meno: 'admin', heslo: 'zle-heslo-123', ciel }), /Nesprávne meno alebo heslo/);
  await assert.rejects(stiahnut({ zdroj: s.base, meno: 'sestra1', heslo: 'Sestra-heslo-01', ciel }), /len správca/);
  await assert.rejects(stiahnut({ zdroj: s.base, meno: 'admin', heslo: 'Testovacie-heslo-1', ciel, lokalny: s.base }), /sám na seba/);
  assert.equal(fs.existsSync(ciel), false);
});
