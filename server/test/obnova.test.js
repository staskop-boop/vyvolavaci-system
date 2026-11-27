'use strict';
// 2026-11-27: obnova hesla správcu na diaľku – zašifrovaná požiadavka v kóde, sestry ostanú prihlásené
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshDataDir, start, client, setupAndLogin } = require('./helpers');

const dir = freshDataDir();
const subor = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adna-obnova-')), 'obnova-hesla.json');
const { zasifruj } = require('../src/obnova');

test('obnova hesla: nastaví nové heslo raz, bez odhlásenia ostatných, cudzí server ju ignoruje', async () => {
  let s = await start({ obnovaSubor: subor });
  const admin = await setupAndLogin(s, 'Stare-heslo-spravcu-1');
  await admin.post('/api/admin/users', { username: 'ambulancia1', password: 'Heslo-sestry-001', role: 'staff' });
  const sestra = client(s.base);
  assert.equal((await sestra.post('/api/auth/login', { username: 'ambulancia1', password: 'Heslo-sestry-001' })).status, 200);
  // zlé pokusy zablokujú konto admin
  for (let i = 0; i < 6; i++) await client(s.base).post('/api/auth/login', { username: 'admin', password: 'zle-heslo-1234' });
  const k = (await client(s.base).get('/api/public/obnova-kluc')).data;
  assert.match(k.publicKey, /BEGIN PUBLIC KEY/);
  assert.equal(k.posledna, null);

  // požiadavka pre iný server (iný odtlačok) sa nepoužije
  fs.writeFileSync(subor, JSON.stringify({ ...zasifruj(k.publicKey, 'iny', { id: 'x1', username: 'admin', password: 'Nove-heslo-spravcu-2' }) }));
  await s.close();
  s = await start({ obnovaSubor: subor });
  assert.equal((await client(s.base).post('/api/auth/login', { username: 'admin', password: 'Nove-heslo-spravcu-2' })).status, 401);

  // správna požiadavka
  fs.writeFileSync(subor, JSON.stringify(zasifruj(k.publicKey, k.fingerprint, { id: 'o1', username: 'admin', password: 'Nove-heslo-spravcu-2' })));
  assert.ok(!fs.readFileSync(subor, 'utf8').includes('Nove-heslo'), 'heslo nesmie byť v súbore čitateľné');
  await s.close();
  s = await start({ obnovaSubor: subor });
  const sestra2 = client(s.base);
  // nový server má rovnaký kľúč (v dátovom adresári)
  assert.equal((await client(s.base).get('/api/public/obnova-kluc')).data.fingerprint, k.fingerprint);
  assert.equal((await client(s.base).post('/api/auth/login', { username: 'admin', password: 'Stare-heslo-spravcu-1' })).status, 401);
  assert.equal((await client(s.base).post('/api/auth/login', { username: 'Admin', password: 'Nove-heslo-spravcu-2' })).status, 200);
  assert.ok((await client(s.base).get('/api/public/obnova-kluc')).data.posledna);
  // sestra ostala prihlásená (cookie zo starého spustenia platí aj na novom)
  const sc = sestra.cookie;
  const r = await fetch(s.base + '/api/staff/state', { headers: { Cookie: sc } });
  assert.equal(r.status, 200);
  void sestra2;

  // tá istá požiadavka sa druhýkrát nepoužije (správca si medzitým heslo zmenil)
  s.auth.setPasswordKeepSessions('admin', 'Dalsie-heslo-spravcu-3');
  await s.close();
  s = await start({ obnovaSubor: subor });
  assert.equal((await client(s.base).post('/api/auth/login', { username: 'admin', password: 'Dalsie-heslo-spravcu-3' })).status, 200);
  await s.close();
  assert.ok(fs.existsSync(path.join(dir, 'obnova-kluc.pem')));
});
