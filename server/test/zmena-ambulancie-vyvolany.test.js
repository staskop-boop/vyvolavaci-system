'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { freshDataDir, start, setupAndLogin } = require('./helpers');

freshDataDir();

// 2026-11-23 (Pali): sestra zmení ambulanciu aj vyvolanému pacientovi (u lekára, u sestry, na ukončení)
test('zmena ambulancie vyvolaného pacienta', async (t) => {
  const s = await start();
  t.after(() => s.close());
  const admin = await setupAndLogin(s);
  const [a1, a2] = (await admin.get('/api/admin/rooms')).data.rooms;
  const day = (await admin.get('/api/staff/state')).data.day;

  await t.test('pacient u lekára ide k lekárovi inej ambulancie', async () => {
    let r = await admin.post('/api/staff/cards', { cardNo: '25', plannedTime: '00:10', roomId: a2.id });
    const id = r.data.ticket.id;
    await admin.post(`/api/staff/tickets/${id}/call`, { roomId: a2.id });
    await admin.post(`/api/staff/tickets/${id}/to-doctor`, {});
    r = await admin.post(`/api/staff/tickets/${id}/call`, { roomId: a2.id });
    assert.equal(r.data.ticket.stage, 'doctor');
    const sentAt = r.data.ticket.toDoctorAt;
    r = await admin.post(`/api/staff/tickets/${id}/room`, { roomId: a1.id, stage: 'doctor' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.ticket.status, 'waiting');
    assert.equal(r.data.ticket.stage, 'doctor');
    assert.equal(r.data.ticket.homeRoomId, a1.id);
    assert.equal(r.data.ticket.roomId, null);
    assert.equal(r.data.ticket.toDoctorAt, sentAt, 'poradie k lekárovi podľa pôvodného času');
    // ambulancia 1 ho vyvolá k lekárovi
    r = await admin.post('/api/staff/call-next', { roomId: a1.id, stage: 'doctor' });
    assert.equal(r.data.ticket.code, '25');
    assert.equal(r.data.ticket.roomId, a1.id);
    assert.equal(r.data.ticket.stage, 'doctor');
    const h = (await admin.get(`/api/staff/history?day=${day}`)).data;
    assert.ok(h.events.some((e) => e.type === 'moved' && e.ticketId === id));
    await admin.post(`/api/staff/tickets/${id}/done`, {});
  });

  await t.test('pacient u sestry ide do radu sestry inej ambulancie, predvolene ostáva krok', async () => {
    let r = await admin.post('/api/staff/cards', { cardNo: '26', plannedTime: '00:20', roomId: a1.id });
    const id = r.data.ticket.id;
    await admin.post(`/api/staff/tickets/${id}/call`, { roomId: a1.id });
    r = await admin.post(`/api/staff/tickets/${id}/room`, { roomId: a2.id });
    assert.equal(r.data.ticket.status, 'waiting');
    assert.equal(r.data.ticket.stage, 'nurse');
    assert.equal(r.data.ticket.homeRoomId, a2.id);
    assert.equal(r.data.ticket.toDoctorAt, null);
    // u sestry → rovno k lekárovi inej ambulancie
    await admin.post(`/api/staff/tickets/${id}/call`, { roomId: a2.id });
    r = await admin.post(`/api/staff/tickets/${id}/room`, { roomId: a1.id, stage: 'doctor' });
    assert.equal(r.data.ticket.stage, 'doctor');
    assert.ok(r.data.ticket.toDoctorAt);
    await admin.post(`/api/staff/tickets/${id}/done`, {});
  });

  await t.test('pacient na ukončení u sestry ide k inému lekárovi', async () => {
    let r = await admin.post('/api/staff/cards', { cardNo: '27', plannedTime: '00:30', roomId: a2.id, stage: 'doctor' });
    const id = r.data.ticket.id;
    await admin.post(`/api/staff/tickets/${id}/call`, { roomId: a2.id });
    await admin.post(`/api/staff/tickets/${id}/to-final`, {});
    r = await admin.post(`/api/staff/tickets/${id}/room`, { roomId: a1.id });
    assert.equal(r.data.ticket.status, 'waiting');
    assert.equal(r.data.ticket.stage, 'doctor');
    assert.equal(r.data.ticket.finalAt, null);
    r = await admin.post(`/api/staff/tickets/${id}/room`, { roomId: a1.id, stage: 'zle' });
    assert.equal(r.status, 400);
    // štatistiky sa nezrútia
    r = await admin.get(`/api/admin/stats?from=${day}&to=${day}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
  });

  await t.test('oprava: pacient bol ošetrený v inej ambulancii – zmení sa kartička aj štatistiky', async () => {
    await admin.post(`/api/staff/rooms/${a1.id}/doctor`, { name: 'MUDr. Prvý' });
    await admin.post(`/api/staff/rooms/${a2.id}/doctor`, { name: 'MUDr. Druhý' });
    let r = await admin.post('/api/staff/cards', { cardNo: '28', plannedTime: '00:40', roomId: a2.id, stage: 'doctor' });
    const id = r.data.ticket.id;
    await admin.post(`/api/staff/tickets/${id}/call`, { roomId: a2.id });
    await admin.post(`/api/staff/tickets/${id}/to-final`, {});
    r = await admin.post(`/api/staff/tickets/${id}/room`, { roomId: a1.id, stage: 'here' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.ticket.status, 'called');
    assert.equal(r.data.ticket.stage, 'final');
    assert.equal(r.data.ticket.roomId, a1.id);
    assert.equal(r.data.ticket.roomName, a1.name);
    await admin.post(`/api/staff/tickets/${id}/done`, {});
    // aj ukončeného možno opraviť (späť na 2 a znova na 1)
    r = await admin.post(`/api/staff/tickets/${id}/room`, { roomId: a2.id, stage: 'here' });
    assert.equal(r.data.ticket.status, 'done');
    assert.equal(r.data.ticket.roomId, a2.id);
    r = await admin.post(`/api/staff/tickets/${id}/room`, { roomId: a1.id, stage: 'here' });
    assert.equal(r.data.ticket.roomId, a1.id);
    const st = (await admin.get(`/api/admin/stats?from=${day}&to=${day}&groupBy=doctor`)).data;
    const txt = JSON.stringify(st);
    assert.ok(txt.includes('MUDr. Prvý'), 'pacient sa ráta lekárovi novej ambulancie');
    const h = (await admin.get(`/api/staff/history?day=${day}`)).data;
    assert.ok(h.events.some((e) => e.type === 'moved' && e.ticketId === id && /oprava/.test(e.note || '')));
    // čakajúceho opraviť nemožno (zaradí sa bežne)
    r = await admin.post('/api/staff/cards', { cardNo: '29', plannedTime: '00:50', roomId: a2.id });
    r = await admin.post(`/api/staff/tickets/${r.data.ticket.id}/room`, { roomId: a1.id, stage: 'here' });
    assert.equal(r.status, 409);
  });
});
