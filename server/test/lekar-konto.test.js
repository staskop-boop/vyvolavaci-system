'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./helpers');
h.freshDataDir();

let s, admin, kiosk, lekar, room;
before(async () => {
  s = await h.start({ kioskRateLimit: 100000 }); admin = await h.setupAndLogin(s); kiosk = h.client(s.base);
  room = (await admin.get('/api/staff/state')).data.rooms[0];
});
after(() => s.close());
const reg = async () => (await kiosk.post('/api/kiosk/tickets', { requestId: crypto.randomUUID() })).data.ticket;

test('správca vytvorí konto lekára; lekár nemá nastavenia', async () => {
  const r = await admin.post('/api/admin/users', { username: 'kudela', password: 'Heslo-lekara-01', roomId: room.id, role: 'admin', doctorName: 'MUDr. Ján Kúdela' });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.doctorName, 'MUDr. Ján Kúdela');
  assert.equal(r.data.user.role, 'staff', 'lekárske konto nemôže byť správca');
  lekar = h.client(s.base);
  const l = await lekar.post('/api/auth/login', { username: 'kudela', password: 'Heslo-lekara-01' });
  assert.equal(l.status, 200); assert.equal(l.data.user.doctorName, 'MUDr. Ján Kúdela');
  assert.equal((await lekar.get('/api/admin/settings')).status, 403);
  assert.equal((await lekar.get('/api/auth/me')).data.user.doctorName, 'MUDr. Ján Kúdela');
});

test('lekár vyvoláva a vybavuje, ale nepridáva pacientov ani nemení oznamy', async () => {
  assert.equal((await lekar.post('/api/staff/cards', { cardNo: '12', plannedTime: '23:00', roomId: room.id })).status, 403);
  assert.equal((await lekar.post('/api/staff/announcement', { text: 'test' })).status, 403);
  assert.equal((await lekar.post(`/api/staff/rooms/${room.id}/doctor`, { name: 'Niekto iný' })).status, 403);
  const t = await reg();
  assert.equal((await lekar.post(`/api/staff/tickets/${t.id}/planned`, { plannedTime: '23:00' })).status, 403);
  const c = await lekar.post('/api/staff/call-next', { roomId: room.id });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.call.doctorName, 'MUDr. Ján Kúdela', 'meno lekára sa ukáže na TV');
  assert.equal((await lekar.post(`/api/staff/tickets/${t.id}/done`)).status, 200);
  const ev = s.store.db.prepare("SELECT doctor FROM ticket_events WHERE ticket_id = ? AND type = 'call'").get(t.id);
  assert.equal(ev.doctor, 'MUDr. Ján Kúdela');
});

test('môj prehľad: lekár vidí len svoje údaje, sestra/správca nie', async () => {
  // iný lekár (zadaný sestrou) v druhej ambulancii
  const st = (await admin.get('/api/staff/state')).data;
  await admin.post(`/api/staff/rooms/${st.rooms[1].id}/doctor`, { name: 'MUDr. Iný Lekár' });
  const t2 = await reg();
  await admin.post(`/api/staff/tickets/${t2.id}/call`, { roomId: st.rooms[1].id });
  const r = await lekar.get(`/api/staff/my-stats?from=${st.day}&to=${st.day}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.doctor, 'MUDr. Ján Kúdela');
  assert.equal(r.data.summary.patients, 1);
  assert.equal(r.data.days.length, 1);
  assert.equal(r.data.clinic.patients, 2, 'porovnanie s celou ambulanciou bez mien iných lekárov');
  assert.equal(JSON.stringify(r.data).includes('Iný Lekár'), false);
  assert.equal((await admin.get(`/api/staff/my-stats?from=${st.day}&to=${st.day}`)).status, 403);
});

test('zmena typu konta lekár → sestra odhlási konto', async () => {
  const u = (await admin.get('/api/admin/users')).data.users.find((x) => x.username === 'kudela');
  const r = await admin.put('/api/admin/users/' + u.id, { doctorName: null });
  assert.equal(r.status, 200); assert.equal(r.data.user.doctorName, null);
  assert.equal((await lekar.get('/api/staff/state')).status, 401);
});
