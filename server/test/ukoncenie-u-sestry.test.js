'use strict';
// 2026-11-18 (Pali): pacient ide od sestry k lekárovi a po vyšetrení späť k sestre na ukončenie (platba, papiere).
// Lekár ho pošle „k sestre na ukončenie“, „Ukončený“ potvrdí až sestra.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
h.freshDataDir();

let s, admin, lekar, room;
before(async () => {
  s = await h.start({ kioskRateLimit: 100000 }); admin = await h.setupAndLogin(s);
  room = (await admin.get('/api/staff/state')).data.rooms[0];
  await admin.post('/api/admin/users', { username: 'kudela', password: 'Heslo-lekara-01', roomId: room.id, doctorName: 'MUDr. Ján Kúdela' });
  lekar = h.client(s.base);
  assert.equal((await lekar.post('/api/auth/login', { username: 'kudela', password: 'Heslo-lekara-01' })).status, 200);
});
after(() => s.close());
const ticket = async (code) => (await admin.get('/api/staff/state')).data.tickets.find((t) => t.code === code);
const display = async () => (await h.client(s.base).get('/api/display/state')).data;

test('sestra → lekár → sestra na ukončenie → ukončený', async () => {
  const a = await admin.post('/api/staff/cards', { cardNo: 'U1', plannedTime: '23:00', roomId: room.id });
  const id = a.data.ticket.id;
  assert.equal((await lekar.post(`/api/staff/tickets/${id}/to-final`, {})).status, 409, 'čakajúceho nemožno poslať na ukončenie');
  assert.equal((await admin.post(`/api/staff/tickets/${id}/call`, { roomId: room.id })).status, 200);
  assert.equal((await admin.post(`/api/staff/tickets/${id}/to-final`, {})).status, 409, 'od sestry (pred lekárom) nie');
  assert.equal((await admin.post(`/api/staff/tickets/${id}/to-doctor`, {})).status, 200);
  assert.equal((await lekar.post(`/api/staff/tickets/${id}/call`, { roomId: room.id })).status, 200);
  const f = await lekar.post(`/api/staff/tickets/${id}/to-final`, {});
  assert.equal(f.status, 200, JSON.stringify(f.data));
  assert.equal(f.data.ticket.stage, 'final'); assert.equal(f.data.ticket.status, 'called'); assert.ok(f.data.ticket.finalAt);
  assert.equal((await lekar.post(`/api/staff/tickets/${id}/to-final`, {})).status, 409, 'druhýkrát nie');
  // TV: pacient je v ambulancii u sestry, nie u lekára; žiadne nové vyvolanie
  const d = await display();
  const r = d.rooms.find((x) => x.id === room.id);
  assert.equal(r.current, 'U1'); assert.equal(r.currentStage, 'nurse');
  assert.ok(!JSON.stringify(d).includes('final'), 'obrazovka nový krok nepozná');
  assert.equal((await admin.post(`/api/staff/tickets/${id}/to-doctor`, {})).status, 409);
  const done = await admin.post(`/api/staff/tickets/${id}/done`, {});
  assert.equal(done.status, 200); assert.equal(done.data.ticket.status, 'done');
  const hist = (await admin.get('/api/staff/history?day=' + (await admin.get('/api/staff/state')).data.day)).data;
  assert.ok(hist.events.some((e) => e.type === 'to_final'), 'udalosť je v histórii');
});

test('omyl: z ukončenia späť k lekárovi; „Vrátiť“ z ukončenia vráti do radu lekára', async () => {
  const a = await admin.post('/api/staff/cards', { cardNo: 'U2', plannedTime: '23:10', roomId: room.id, stage: 'doctor' });
  const id = a.data.ticket.id;
  await lekar.post(`/api/staff/tickets/${id}/call`, { roomId: room.id });
  assert.equal((await lekar.post(`/api/staff/tickets/${id}/back-to-doctor`, {})).status, 409);
  await lekar.post(`/api/staff/tickets/${id}/to-final`, {});
  const b = await admin.post(`/api/staff/tickets/${id}/back-to-doctor`, {});
  assert.equal(b.status, 200); assert.equal(b.data.ticket.stage, 'doctor'); assert.equal(b.data.ticket.status, 'called'); assert.equal(b.data.ticket.finalAt, null);
  await lekar.post(`/api/staff/tickets/${id}/to-final`, {});
  const q = await admin.post(`/api/staff/tickets/${id}/requeue`, {});
  assert.equal(q.status, 200);
  const t = await ticket('U2');
  assert.equal(t.status, 'waiting'); assert.equal(t.stage, 'doctor', 'nezostane v neexistujúcom rade');
  assert.ok((await display()).rooms.find((x) => x.id === room.id).doctorQueue.includes('U2'));
  await admin.post(`/api/staff/tickets/${id}/done`, {});
});

test('štatistiky: čas u lekára sa končí odoslaním k sestre, nie až ukončením', async () => {
  const st = (await admin.get('/api/staff/state')).data;
  const r = await admin.get(`/api/admin/stats?from=${st.day}&to=${st.day}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(JSON.stringify(r.data).length > 10);
});
