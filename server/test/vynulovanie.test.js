'use strict';
// Vynulovanie testovacích údajov pred ostrou prevádzkou: zmažú sa pacienti, história a počítadlá, kontá a nastavenia ostanú.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers');
const dataDir = h.freshDataDir();
const SKRIPT = path.join(__dirname, '..', 'scripts', 'vynulovat-data.js');

let s, admin;
before(async () => { s = await h.start({ kioskRateLimit: 100000 }); admin = await h.setupAndLogin(s); });
after(() => s && s.close());

test('vynulovanie zmaže pacientov a históriu, ponechá kontá, ambulancie a nastavenia; urobí zálohu', async () => {
  const kiosk = h.client(s.base);
  const st = (await admin.get('/api/staff/state')).data;
  const r1 = st.rooms[0];
  await admin.post(`/api/staff/rooms/${r1.id}/doctor`, { name: 'MUDr. Test Prvý' });
  assert.equal((await admin.post('/api/admin/users', { username: 'sestra1', password: 'Heslo-sestra-01', roomId: r1.id })).status, 201);
  const a = (await kiosk.post('/api/kiosk/tickets', { requestId: crypto.randomUUID() })).data.ticket;
  await kiosk.post('/api/kiosk/tickets', { requestId: crypto.randomUUID() });
  await admin.post(`/api/staff/tickets/${a.id}/call`, { roomId: r1.id });
  await admin.post(`/api/staff/tickets/${a.id}/done`);
  const nastaveniaPred = (await admin.get('/api/admin/settings')).data;
  await s.close(); s = null;   // server počas vynulovania nebeží

  // bez potvrdenia nič nezmaže
  const bez = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SKRIPT], { env: process.env, encoding: 'utf8' });
  assert.equal(bez.status, 2);

  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SKRIPT, '--potvrdit'], { env: process.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Pred vynulovaním: pacienti 2/);
  assert.match(r.stdout, /Po vynulovaní:\s+pacienti 0, záznamy histórie 0, dni s počítadlom 0/);
  const zalohy = fs.readdirSync(path.join(dataDir, 'zalohy')).filter((f) => f.startsWith('adna-pred-vynulovanim-'));
  assert.equal(zalohy.length, 1);

  s = await h.start({ kioskRateLimit: 100000 });
  const c = h.client(s.base);
  assert.equal((await c.post('/api/auth/login', { username: 'admin', password: 'Testovacie-heslo-1' })).status, 200, 'heslo správcu ostalo');
  assert.equal((await h.client(s.base).post('/api/auth/login', { username: 'sestra1', password: 'Heslo-sestra-01' })).status, 200, 'konto sestry ostalo');
  const st2 = (await c.get('/api/staff/state')).data;
  assert.equal(st2.rooms.length, st.rooms.length);
  assert.equal(st2.tickets?.length ?? 0, 0);
  assert.deepEqual((await c.get('/api/admin/settings')).data, nastaveniaPred, 'nastavenia ostali');
  const stats = (await c.get(`/api/admin/stats?from=${st.day}&to=${st.day}`)).data;
  assert.equal(stats.total.patients, 0);
  // číslovanie začína odznova
  const novy = (await h.client(s.base).post('/api/kiosk/tickets', { requestId: crypto.randomUUID() })).data.ticket;
  assert.match(String(novy.code), /(^|\D)0*1$/, `nové číslo ${novy.code}`);
});
