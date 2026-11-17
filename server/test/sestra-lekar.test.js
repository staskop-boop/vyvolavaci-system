'use strict';
// 2026-11-17 (Pali): pacient ide najprv k sestre (na TV meno a fotka sestry), potom ho volá lekár (na TV lekár).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
h.freshDataDir();

let s, admin, pub, rooms;
before(async () => {
  s = await h.start(); admin = await h.setupAndLogin(s); pub = h.client(s.base);
  rooms = (await admin.get('/api/staff/state')).data.rooms;
});
after(() => s.close());

test('ranné nastavenie: sestra a lekár ambulancie, zoznam sestier na výber', async () => {
  const st0 = (await admin.get('/api/staff/state')).data;
  assert.ok(st0.settings.nurseList.includes('Daniela Fetyková'));
  assert.equal((await admin.post(`/api/staff/rooms/${rooms[0].id}/nurse`, { name: 'X' })).status, 400);
  assert.equal((await admin.post(`/api/staff/rooms/${rooms[0].id}/nurse`, { name: 'Daniela Fetyková' })).status, 200);
  assert.equal((await admin.post(`/api/staff/rooms/${rooms[0].id}/doctor`, { name: 'MUDr. Pavel Staško' })).status, 200);
  const st = (await admin.get('/api/staff/state')).data;
  assert.equal(st.nurses[rooms[0].id], 'Daniela Fetyková');
  const d = (await pub.get('/api/display/state')).data;
  assert.equal(d.rooms.find((r) => r.id === rooms[0].id).nurseName, 'Daniela Fetyková');
  // prázdne meno = sestra nezadaná
  assert.equal((await admin.post(`/api/staff/rooms/${rooms[1].id}/nurse`, { name: '' })).status, 200);
});

test('1. vyvolanie k sestre, K lekárovi → rad lekára, 2. vyvolanie ukáže lekára', async () => {
  const a = (await admin.post('/api/staff/cards', { cardNo: '21', plannedTime: '00:01', roomId: rooms[0].id })).data.ticket;
  const c1 = await admin.post('/api/staff/call-next', { roomId: rooms[0].id });
  assert.equal(c1.status, 200);
  assert.equal(c1.data.call.code, '21');
  assert.equal(c1.data.call.stage, 'nurse');
  assert.equal(c1.data.call.nurseName, 'Daniela Fetyková');
  assert.equal(c1.data.call.doctorName, null, 'pri sestre sa lekár na TV neukazuje');
  let d = (await pub.get('/api/display/state')).data;
  assert.equal(d.current.stage, 'nurse');
  assert.equal(d.current.nurseName, 'Daniela Fetyková');
  // zopakované vyvolanie ostáva k sestre
  const rc = await admin.post(`/api/staff/tickets/${a.id}/recall`, {});
  assert.equal(rc.data.call.stage, 'nurse');
  // k lekárovi sa dá poslať len pacient u sestry
  const b = (await admin.post('/api/staff/cards', { cardNo: '22', plannedTime: '00:02', roomId: rooms[0].id })).data.ticket;
  assert.equal((await admin.post(`/api/staff/tickets/${b.id}/to-doctor`, {})).status, 409);
  const sent = await admin.post(`/api/staff/tickets/${a.id}/to-doctor`, {});
  assert.equal(sent.status, 200);
  assert.equal(sent.data.ticket.status, 'waiting');
  assert.equal(sent.data.ticket.stage, 'doctor');
  assert.equal(sent.data.ticket.homeRoomId, rooms[0].id);
  assert.ok(sent.data.ticket.toDoctorAt);
  assert.equal((await admin.post(`/api/staff/tickets/${a.id}/to-doctor`, {})).status, 409, 'dvakrát sa poslať nedá');
  d = (await pub.get('/api/display/state')).data;
  assert.equal(d.queue.some((q) => q.code === '21'), false, '„Na rade“ s termínmi je len pre sestru');
  assert.deepEqual(d.rooms.find((r) => r.id === rooms[0].id).doctorQueue, ['21']);
  assert.equal(d.doctorQueueCount, 1);
  assert.equal(d.rooms.find((r) => r.id === rooms[0].id).current, null, 'po odchode od sestry je ambulancia voľná');
  // ďalší k sestre je 22 (rad sestry nevidí 21)
  const c2 = await admin.post('/api/staff/call-next', { roomId: rooms[0].id });
  assert.equal(c2.data.call.code, '22');
  // lekár si volá z radu lekára
  const c3 = await admin.post('/api/staff/call-next', { roomId: rooms[0].id, stage: 'doctor' });
  assert.equal(c3.status, 200);
  assert.equal(c3.data.call.code, '21');
  assert.equal(c3.data.call.stage, 'doctor');
  assert.equal(c3.data.call.doctorName, 'MUDr. Pavel Staško');
  assert.equal(c3.data.call.nurseName, null);
  d = (await pub.get('/api/display/state')).data;
  assert.equal(d.current.code, '21'); assert.equal(d.current.stage, 'doctor'); assert.equal(d.current.doctorName, 'MUDr. Pavel Staško');
  assert.equal((await admin.post('/api/staff/call-next', { roomId: rooms[0].id, stage: 'doctor' })).status, 409);
  assert.equal((await admin.post(`/api/staff/tickets/${a.id}/done`)).status, 200);
  // priamo k lekárovi: ostáva v ambulancii, TV sa nehlási
  let calls = 0; const on = () => calls++;
  s.store.on('call', on);
  const dir = await admin.post(`/api/staff/tickets/${b.id}/to-doctor`, { direct: true });
  s.store.off('call', on);
  assert.equal(dir.data.ticket.status, 'called');
  assert.equal(dir.data.ticket.stage, 'doctor');
  assert.equal(calls, 0, 'pacient je už v ambulancii – bez hlásenia na TV');
  const hist = (await admin.get('/api/staff/history?day=' + d.day)).data;
  assert.ok(hist.events.some((e) => e.ticketId === b.id && e.type === 'to_doctor' && e.note === 'priamo'));
});

test('ambulancia „dnes neordinuje nikto“ zruší aj sestru', async () => {
  await admin.post(`/api/staff/rooms/${rooms[1].id}/nurse`, { name: 'Bianka Sotáková' });
  assert.equal((await admin.post(`/api/staff/rooms/${rooms[1].id}/closed`, { closed: true })).status, 200);
  assert.equal((await admin.get('/api/staff/state')).data.nurses[rooms[1].id], undefined);
});
