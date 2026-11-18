'use strict';
// 2026-11-18 (Pali): pri čakajúcom pacientovi sa dá zvoliť „ide k sestre“ / „ide k lekárovi“ (aj dodatočne zmeniť).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
h.freshDataDir();

let s, admin, room;
before(async () => {
  s = await h.start({ kioskRateLimit: 100000 }); admin = await h.setupAndLogin(s);
  room = (await admin.get('/api/staff/state')).data.rooms[0];
});
after(() => s.close());
const display = async () => (await h.client(s.base).get('/api/display/state')).data;

test('pacient pridaný s voľbou „k lekárovi“ ide rovno do radu lekára', async () => {
  const r = await admin.post('/api/staff/cards', { cardNo: 'L1', plannedTime: '23:00', roomId: room.id, stage: 'doctor' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.ticket.stage, 'doctor'); assert.ok(r.data.ticket.toDoctorAt);
  const n = await admin.post('/api/staff/cards', { cardNo: 'S1', plannedTime: '23:05', roomId: room.id });
  assert.equal(n.data.ticket.stage, 'nurse', 'predvolene ide k sestre');
  const d = await display();
  assert.ok(d.queue.every((q) => q.code !== 'L1'), 'nie je v rade k sestre');
  assert.ok(d.rooms.find((x) => x.id === room.id).doctorQueue.includes('L1'), 'je v rade k lekárovi');
  // rad sestry vyvolá S1, rad lekára L1
  const c1 = await admin.post('/api/staff/call-next', { roomId: room.id });
  assert.equal(c1.data.ticket.code, 'S1'); assert.equal(c1.data.call.stage, 'nurse');
  const c2 = await admin.post('/api/staff/call-next', { roomId: room.id, stage: 'doctor' });
  assert.equal(c2.data.ticket.code, 'L1'); assert.equal(c2.data.call.stage, 'doctor');
  await admin.post(`/api/staff/tickets/${c1.data.ticket.id}/done`); await admin.post(`/api/staff/tickets/${c2.data.ticket.id}/done`);
});

test('voľbu možno zmeniť v oboch smeroch; neznáma hodnota sa odmietne', async () => {
  const t = (await admin.post('/api/staff/cards', { cardNo: 'Z1', plannedTime: '23:10', roomId: room.id })).data.ticket;
  const a = await admin.post(`/api/staff/tickets/${t.id}/edit`, { stage: 'doctor' });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.data.ticket.stage, 'doctor'); assert.ok(a.data.ticket.toDoctorAt);
  assert.equal(a.data.ticket.code, 'Z1'); assert.equal(a.data.ticket.plannedAt, t.plannedAt, 'ostatné údaje sa nemenia');
  assert.equal((await admin.post('/api/staff/call-next', { roomId: room.id })).status, 409, 'k sestre už nikto nečaká');
  const b = await admin.post(`/api/staff/tickets/${t.id}/edit`, { stage: 'nurse' });
  assert.equal(b.data.ticket.stage, 'nurse'); assert.equal(b.data.ticket.toDoctorAt, null);
  assert.equal((await admin.post('/api/staff/call-next', { roomId: room.id, stage: 'doctor' })).status, 409, 'na lekára už nikto nečaká');
  assert.equal((await admin.post(`/api/staff/tickets/${t.id}/edit`, { stage: 'inde' })).status, 400);
  const types = s.store.db.prepare('SELECT type FROM ticket_events WHERE ticket_id = ? ORDER BY id').all(t.id).map((e) => e.type);
  assert.deepEqual(types, ['created', 'to_doctor', 'to_nurse']);
  // štatistiky s takýmito záznamami nespadnú
  const day = (await admin.get('/api/staff/state')).data.day;
  assert.equal((await admin.get(`/api/admin/stats?from=${day}&to=${day}`)).status, 200);
});

test('rad k lekárovi: pri pacientovi je termín aj čas vyvolania sestrou', async () => {
  const a = await admin.post('/api/staff/cards', { cardNo: 'N7', plannedTime: '23:30', roomId: room.id });
  const b = await admin.post('/api/staff/cards', { cardNo: 'N8', plannedTime: '23:35', roomId: room.id, stage: 'doctor' });
  assert.equal((await admin.post(`/api/staff/tickets/${a.data.ticket.id}/call`, { roomId: room.id })).status, 200);
  assert.equal((await admin.post(`/api/staff/tickets/${a.data.ticket.id}/to-doctor`, {})).status, 200);
  const ts = (await admin.get('/api/staff/state')).data.tickets;
  const n7 = ts.find((t) => t.code === 'N7'); const n8 = ts.find((t) => t.code === 'N8');
  assert.equal(n7.stage, 'doctor'); assert.equal(n7.status, 'waiting');
  assert.ok(n7.plannedAt, 'termín ostáva'); assert.ok(n7.nurseCalledAt, 'čas vyvolania sestrou');
  assert.ok(n7.toDoctorAt >= n7.nurseCalledAt);
  assert.equal(n8.nurseCalledAt, null, 'pacient bez sestry nemá čas vyvolania sestrou');
});
