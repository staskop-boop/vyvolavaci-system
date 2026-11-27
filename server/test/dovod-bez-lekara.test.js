'use strict';
// 2026-11-27 (Pali): keď sestra ukončí pacienta, ktorý nebol u lekára, musí vybrať dôvod
// (napr. „zabudla prekliknúť k lekárovi“, „omyl“). Dôvod je v histórii a v štatistikách / prehľade.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
h.freshDataDir();

let s, admin, lekar, room, day;
before(async () => {
  s = await h.start({ kioskRateLimit: 100000 }); admin = await h.setupAndLogin(s);
  const st = (await admin.get('/api/staff/state')).data;
  room = st.rooms[0]; day = st.day;
  await admin.post('/api/admin/users', { username: 'kudela', password: 'Heslo-lekara-01', roomId: room.id, doctorName: 'MUDr. Ján Kúdela' });
  lekar = h.client(s.base);
  assert.equal((await lekar.post('/api/auth/login', { username: 'kudela', password: 'Heslo-lekara-01' })).status, 200);
});
after(() => s.close());
const card = async (no) => (await admin.post('/api/staff/cards', { cardNo: no, plannedTime: '23:00', roomId: room.id })).data.ticket.id;

test('ponuka dôvodov je v stave pre personál', async () => {
  const st = (await admin.get('/api/staff/state')).data;
  const ids = st.doneReasons.map((r) => r.id);
  for (const x of ['zabudla', 'omyl', 'ine']) assert.ok(ids.includes(x), x);
});

test('bez lekára sa pacient bez dôvodu ukončiť nedá; s dôvodom áno a dôvod je v histórii', async () => {
  const id = await card('D1');
  await admin.post(`/api/staff/tickets/${id}/call`, { roomId: room.id });
  const r0 = await admin.post(`/api/staff/tickets/${id}/done`, {});
  assert.equal(r0.status, 400); assert.match(r0.data.error.message, /nebol u lekára/);
  assert.equal((await admin.post(`/api/staff/tickets/${id}/done`, { reason: 'nezmysel' })).status, 400);
  assert.equal((await admin.post(`/api/staff/tickets/${id}/done`, { reason: 'ine', reasonText: '  ' })).status, 400, 'pri inom dôvode je text povinný');
  const r = await admin.post(`/api/staff/tickets/${id}/done`, { reason: 'zabudla' });
  assert.equal(r.status, 200); assert.equal(r.data.ticket.status, 'done');
  const hist = (await admin.get(`/api/staff/history?day=${day}`)).data;
  const ev = hist.events.filter((e) => e.ticketId === id && e.type === 'done').pop();
  assert.equal(ev.note, 'zabudla'); assert.equal(ev.stage, 'nurse');
});

test('iný dôvod sa uloží aj s textom; pacient v rade k lekárovi tiež potrebuje dôvod', async () => {
  const id = await card('D2');
  await admin.post(`/api/staff/tickets/${id}/call`, { roomId: room.id });
  await admin.post(`/api/staff/tickets/${id}/to-doctor`, {});
  assert.equal((await lekar.post(`/api/staff/tickets/${id}/done`, {})).status, 400, 'čaká na lekára, u lekára ešte nebol');
  assert.equal((await lekar.post(`/api/staff/tickets/${id}/done`, { reason: 'ine', reasonText: 'išiel na pohotovosť' })).status, 200);
  const ev = (await admin.get(`/api/staff/history?day=${day}`)).data.events.filter((e) => e.ticketId === id && e.type === 'done').pop();
  assert.equal(ev.note, 'ine: išiel na pohotovosť');
});

test('pacient, ktorý bol u lekára, dôvod nepotrebuje', async () => {
  const a = await card('D3');
  await admin.post(`/api/staff/tickets/${a}/call`, { roomId: room.id });
  await admin.post(`/api/staff/tickets/${a}/to-doctor`, {});
  await lekar.post(`/api/staff/tickets/${a}/call`, { roomId: room.id });
  assert.equal((await lekar.post(`/api/staff/tickets/${a}/done`, {})).status, 200, 'u lekára');
  const b = await card('D4');
  await admin.post(`/api/staff/tickets/${b}/call`, { roomId: room.id });
  await admin.post(`/api/staff/tickets/${b}/to-doctor`, { direct: true });
  await lekar.post(`/api/staff/tickets/${b}/to-final`, {});
  assert.equal((await admin.post(`/api/staff/tickets/${b}/done`, {})).status, 200, 'po lekárovi na ukončení u sestry');
});

test('štatistika lekárov rozpíše „len u sestry“ podľa dôvodu', async () => {
  const r = (await admin.get(`/api/admin/stats?from=${day}&to=${day}`)).data;
  assert.equal(r.nurseOnly, 2);
  const m = Object.fromEntries(r.nurseOnlyReasons.map((x) => [x.reason, x.count]));
  assert.equal(m['Zabudla prekliknúť k lekárovi'], 1);
  assert.equal(m['Iný dôvod: išiel na pohotovosť'], 1);
});
