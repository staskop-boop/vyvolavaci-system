'use strict';
// 2026-11-24 (Pali): štatistiky sa viažu na prihlásené konto lekára / sestry – pri striedaní v tej istej ambulancii
// má každý vlastné čísla; lekár vidí anonymné porovnanie s ostatnými lekármi.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./helpers');
h.freshDataDir();

let s, admin, kiosk, room, day;
const login = async (username, password) => { const c = h.client(s.base); const r = await c.post('/api/auth/login', { username, password }); assert.equal(r.status, 200, JSON.stringify(r.data)); return c; };
before(async () => {
  s = await h.start({ kioskRateLimit: 100000 }); admin = await h.setupAndLogin(s); kiosk = h.client(s.base);
  const st = (await admin.get('/api/staff/state')).data; room = st.rooms[0]; day = st.day;
});
after(() => s.close());
const reg = async () => (await kiosk.post('/api/kiosk/tickets', { requestId: crypto.randomUUID() })).data.ticket;

/** Pacient prejde sestrou (konto `sestra`) k lekárovi (konto `lekar`) a ukončí sa. */
async function patient(sestra, lekar) {
  const t = await reg();
  assert.equal((await sestra.post(`/api/staff/tickets/${t.id}/call`, { roomId: room.id })).status, 200);
  assert.equal((await sestra.post(`/api/staff/tickets/${t.id}/to-doctor`, {})).status, 200);
  const c = await lekar.post('/api/staff/call-next', { roomId: room.id });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal((await lekar.post(`/api/staff/tickets/${t.id}/to-final`)).status, 200);
  assert.equal((await sestra.post(`/api/staff/tickets/${t.id}/done`)).status, 200);
  return t;
}

test('striedanie lekárov aj sestier v tej istej ambulancii – každý má svoje štatistiky', async () => {
  for (const [username, doctorName] of [['prvy', 'MUDr. Prvý Lekár'], ['druhy', 'MUDr. Druhý Lekár']]) {
    assert.equal((await admin.post('/api/admin/users', { username, password: 'Heslo-lekara-01', role: 'staff', doctorName })).status, 201);
  }
  const n1 = await admin.post('/api/admin/users', { username: 'sestraa', password: 'Heslo-sestry-01', roomId: room.id, nurseName: 'Sestra Ranná' });
  assert.equal(n1.status, 201); assert.equal(n1.data.user.nurseName, 'Sestra Ranná');
  assert.equal((await admin.post('/api/admin/users', { username: 'sestrab', password: 'Heslo-sestry-02', roomId: room.id, nurseName: 'Sestra Poobedná' })).status, 201);

  // doobeda: prvý lekár + ranná sestra (2 pacienti)
  let lekar = await login('prvy', 'Heslo-lekara-01');
  let sestra = await login('sestraa', 'Heslo-sestry-01');
  assert.equal((await sestra.get('/api/auth/me')).data.user.nurseName, 'Sestra Ranná');
  await patient(sestra, lekar); await patient(sestra, lekar);
  assert.equal((await admin.get('/api/staff/state')).data.nurses[room.id], 'Sestra Ranná', 'osobné konto sestry sa samo zapíše ako sestra ambulancie (TV)');
  await lekar.post('/api/auth/logout'); await sestra.post('/api/auth/logout');

  // poobede: druhý lekár + poobedná sestra v TEJ ISTEJ ambulancii (3 pacienti)
  lekar = await login('druhy', 'Heslo-lekara-01');
  sestra = await login('sestrab', 'Heslo-sestry-02');
  // prvé vyvolanie poobede: ambulancia má ešte zapísaných ranných – úkon sa aj tak pripíše tomu, kto je prihlásený
  await patient(sestra, lekar); await patient(sestra, lekar); await patient(sestra, lekar);

  const byDoc = (await admin.get(`/api/admin/stats?from=${day}&to=${day}&groupBy=doctor`)).data;
  const pd = Object.fromEntries(byDoc.doctors.map((d) => [d.doctor, d.patients]));
  assert.equal(pd['MUDr. Prvý Lekár'], 2); assert.equal(pd['MUDr. Druhý Lekár'], 3);
  assert.equal(byDoc.total.patients, 5, 'súhrn celého dňa ostáva');
  const byNurse = (await admin.get(`/api/admin/stats?from=${day}&to=${day}&groupBy=nurse`)).data;
  const pn = Object.fromEntries(byNurse.doctors.map((d) => [d.doctor, d.patients]));
  assert.equal(pn['Sestra Ranná'], 2); assert.equal(pn['Sestra Poobedná'], 3);

  // môj prehľad – lekár: len svoje, porovnanie len „ostatní spolu“ (iba jeden ďalší lekár → jednotlivo nie)
  const me = (await lekar.get(`/api/staff/my-stats?from=${day}&to=${day}`)).data;
  assert.equal(me.summary.patients, 3);
  assert.equal(me.clinic.patients, 5);
  assert.equal(me.othersAvg.patients, 2); assert.equal(me.othersAvg.count, 1);
  assert.deepEqual(me.comparison, [], 'pri malom počte lekárov sa jednotlivo neukazujú');
  assert.equal(JSON.stringify(me).includes('Prvý'), false, 'bez mien ostatných lekárov');
  // môj prehľad – sestra
  const mn = await sestra.get(`/api/staff/my-stats?from=${day}&to=${day}`);
  assert.equal(mn.status, 200);
  assert.equal(mn.data.nurse, 'Sestra Poobedná'); assert.equal(mn.data.summary.patients, 3);
  assert.equal(JSON.stringify(mn.data).includes('Ranná'), false);
});

test('pri aspoň 3 ďalších lekároch je porovnanie aj jednotlivo (Lekár A, B, C), bez mien', async () => {
  const st = (await admin.get('/api/staff/state')).data;
  const sestra = await login('sestraa', 'Heslo-sestry-01');
  for (const [i, name] of ['MUDr. Tretí', 'MUDr. Štvrtý'].entries()) {
    await admin.post('/api/admin/users', { username: 'lek' + i, password: 'Heslo-lekara-01', doctorName: name });
    await patient(sestra, await login('lek' + i, 'Heslo-lekara-01'));
  }
  const lekar = await login('druhy', 'Heslo-lekara-01');
  const me = (await lekar.get(`/api/staff/my-stats?from=${st.day}&to=${st.day}`)).data;
  assert.equal(me.othersAvg.count, 3);
  assert.equal(me.comparison.length, 4);
  assert.deepEqual(me.comparison.map((c) => c.label).sort(), ['Lekár A', 'Lekár B', 'Lekár C', 'Vy']);
  for (const n of ['Prvý', 'Tretí', 'Štvrtý']) assert.equal(JSON.stringify(me).includes(n), false);
});

test('konto ambulancie (bez osobného mena) prehľad nemá; zmena na osobné konto sestry odhlási', async () => {
  assert.equal((await admin.post('/api/admin/users', { username: 'ambx', password: 'Heslo-amb-0001', roomId: room.id })).status, 201);
  const amb = await login('ambx', 'Heslo-amb-0001');
  assert.equal((await amb.get(`/api/staff/my-stats?from=${day}&to=${day}`)).status, 403);
  const u = (await admin.get('/api/admin/users')).data.users.find((x) => x.username === 'ambx');
  const r = await admin.put('/api/admin/users/' + u.id, { nurseName: 'Daniela Fetyková' });
  assert.equal(r.status, 200); assert.equal(r.data.user.nurseName, 'Daniela Fetyková');
  assert.equal((await amb.get('/api/staff/state')).status, 401);
  // lekárske konto nemôže mať zároveň meno sestry
  const r2 = await admin.put('/api/admin/users/' + u.id, { doctorName: 'MUDr. X Y' });
  assert.equal(r2.data.user.nurseName, null);
});
