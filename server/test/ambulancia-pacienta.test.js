'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { freshDataDir, start, client, setupAndLogin } = require('./helpers');

freshDataDir();

// 2026-11-16 (Pali): výber ambulancie pri pridaní, zmena ambulancie a zrušenie chybne zadaného pacienta
test('ambulancia pacienta: výber, zmena, zrušenie', async (t) => {
  const s = await start();
  t.after(() => s.close());
  const admin = await setupAndLogin(s);
  const [a1, a2] = (await admin.get('/api/admin/rooms')).data.rooms;

  await t.test('pri pridaní sestra vyberie ambulanciu (aj spoločného pacienta)', async () => {
    let r = await admin.post('/api/staff/cards', { cardNo: '5', plannedTime: '00:10', roomId: a2.id });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.ticket.homeRoomId, a2.id);
    r = await admin.post('/api/staff/cards', { cardNo: '6', plannedTime: '00:20', roomId: null });
    assert.equal(r.data.ticket.homeRoomId, null);
  });

  await t.test('zmena ambulancie – pacienta prevezme druhá ambulancia', async () => {
    const t5 = (await admin.get('/api/staff/state')).data.tickets.find((x) => x.code === '5');
    let r = await admin.post(`/api/staff/tickets/${t5.id}/room`, { roomId: a1.id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.ticket.homeRoomId, a1.id);
    assert.equal(r.data.ticket.homeRoomName, a1.name);
    assert.equal(r.data.ticket.status, 'waiting');
    // ďalší pacient pre ambulanciu 1 je teraz 5
    r = await admin.post('/api/staff/call-next', { roomId: a1.id });
    assert.equal(r.data.ticket.code, '5');
    r = await admin.post(`/api/staff/tickets/${t5.id}/room`, { roomId: 99999 });
    assert.equal(r.status, 400, 'neplatná ambulancia');
    await admin.post(`/api/staff/tickets/${t5.id}/done`, {});
    r = await admin.post(`/api/staff/tickets/${t5.id}/room`, { roomId: a2.id });
    assert.equal(r.status, 409, 'vybaveného nemožno presunúť');
    const day = (await admin.get('/api/staff/state')).data.day;
    const h = (await admin.get(`/api/staff/history?day=${day}`)).data;
    assert.ok(h.events.some((e) => e.type === 'moved' && e.ticketId === t5.id), 'zmena je v histórii');
  });

  await t.test('zrušenie chybne zadaného pacienta', async () => {
    let r = await admin.post('/api/staff/cards', { cardNo: '77', plannedTime: '00:30', roomId: a1.id });
    const id = r.data.ticket.id;
    r = await admin.post(`/api/staff/tickets/${id}/cancel`, {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(!(await admin.get('/api/staff/state')).data.tickets.some((x) => x.id === id), 'zmizol zo zoznamu');
    r = await admin.post('/api/staff/cards', { cardNo: '77', plannedTime: '00:30', roomId: a1.id });
    assert.equal(r.status, 201, 'označenie sa uvoľnilo');
    // vyvolaného (aj vráteného) zrušiť nemožno
    const id2 = r.data.ticket.id;
    await admin.post(`/api/staff/tickets/${id2}/call`, { roomId: a1.id });
    r = await admin.post(`/api/staff/tickets/${id2}/cancel`, {});
    assert.equal(r.status, 409);
    await admin.post(`/api/staff/tickets/${id2}/requeue`, {});
    r = await admin.post(`/api/staff/tickets/${id2}/cancel`, {});
    assert.equal(r.status, 409);
    assert.match(r.data.error.message, /neprítomného/);
  });

  await t.test('úprava čísla, času a ambulancie naraz', async () => {
    let r = await admin.post('/api/staff/cards', { cardNo: '40', plannedTime: '00:40', roomId: a1.id });
    const id = r.data.ticket.id;
    r = await admin.post(`/api/staff/tickets/${id}/edit`, { cardNo: '41', plannedTime: '00:45', roomId: a2.id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.ticket.code, '41');
    assert.equal(r.data.ticket.homeRoomId, a2.id);
    assert.ok(r.data.ticket.plannedAt);
    r = await admin.post(`/api/staff/tickets/${id}/edit`, { cardNo: '6' });
    assert.equal(r.status, 409, 'označenie 6 už čaká');
    r = await admin.post(`/api/staff/tickets/${id}/edit`, { cardNo: '!!' });
    assert.equal(r.status, 400);
  });

  await t.test('úvodné stránky odkazujú na skripty s verziou (obchádza cache Cloudflare)', async () => {
    for (const u of ['/sestra/', '/sestra/index.html', '/obrazovka/', '/tablet/']) {
      const res = await fetch(s.base + u);
      const html = await res.text();
      assert.equal(res.headers.get('cache-control'), 'no-cache', u);
      assert.match(html, /src="app\.js\?v=\w+"/, u);
      assert.match(html, /href="styles\.css\?v=\w+"/, u);
    }
  });

  await t.test('lekár nemôže presúvať ani rušiť', async () => {
    await admin.post('/api/admin/users', { username: 'lekarx', password: 'Heslo-lekara-01', roomId: a1.id, doctorName: 'MUDr. X' });
    const doc = client(s.base);
    await doc.post('/api/auth/login', { username: 'lekarx', password: 'Heslo-lekara-01' });
    const t6 = (await admin.get('/api/staff/state')).data.tickets.find((x) => x.code === '6');
    assert.equal((await doc.post(`/api/staff/tickets/${t6.id}/room`, { roomId: a1.id })).status, 403);
    assert.equal((await doc.post(`/api/staff/tickets/${t6.id}/cancel`, {})).status, 403);
  });
});
