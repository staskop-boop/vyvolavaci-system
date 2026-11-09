'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { freshDataDir, start, client, setupAndLogin } = require('./helpers');

freshDataDir();

test('v2.1: dve pripravovne s vlastnými kontami, spoločná TV, hlásenie meškania', async (t) => {
  const s = await start();
  t.after(() => s.close());
  const admin = await setupAndLogin(s);
  const pub = client(s.base);
  const rooms = (await admin.get('/api/admin/rooms')).data.rooms;
  const [p1, p2] = rooms;
  const s1 = client(s.base), s2 = client(s.base);

  await t.test('správa kont', async () => {
    let r = await admin.post('/api/admin/users', { username: 'pripravovna1', password: 'Heslo-prip-001', roomId: p1.id });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.user.roomName, p1.name);
    r = await admin.post('/api/admin/users', { username: 'pripravovna2', password: 'Heslo-prip-002', roomId: p2.id });
    assert.equal(r.status, 201);
    r = await admin.post('/api/admin/users', { username: 'pripravovna2', password: 'Heslo-prip-002' });
    assert.equal(r.status, 400, 'duplicitné meno');
    r = await admin.post('/api/admin/users', { username: 'x', password: 'Heslo-prip-002' });
    assert.equal(r.status, 400, 'krátke meno');
    r = await admin.post('/api/admin/users', { username: 'kratke', password: 'kratke' });
    assert.equal(r.status, 400, 'krátke heslo');
    r = await s1.post('/api/auth/login', { username: 'pripravovna1', password: 'Heslo-prip-001' });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.roomId, p1.id);
    assert.equal(r.data.user.role, 'staff');
    await s2.post('/api/auth/login', { username: 'pripravovna2', password: 'Heslo-prip-002' });
    r = await s1.get('/api/admin/users');
    assert.equal(r.status, 403, 'sestra nemá prístup k nastaveniam');
    const me = (await admin.get('/api/auth/me')).data.user;
    r = await admin.put(`/api/admin/users/${me.id}`, { role: 'staff' });
    assert.equal(r.status, 400, 'posledný admin musí ostať');
  });

  await t.test('pacient patrí pracovisku sestry; označenie jedinečné naprieč pracoviskami', async () => {
    let r = await s1.post('/api/staff/cards', { cardNo: '1', plannedTime: '00:10' });
    assert.equal(r.data.ticket.homeRoomId, p1.id);
    r = await s2.post('/api/staff/cards', { cardNo: 'A', plannedTime: '00:05' });
    assert.equal(r.data.ticket.homeRoomId, p2.id);
    await s1.post('/api/staff/cards', { cardNo: '2', plannedTime: '00:20' });
    r = await s2.post('/api/staff/cards', { cardNo: '1' });
    assert.equal(r.status, 409);
    assert.match(r.data.error.message, new RegExp(`Označenie 1 je už v zozname \\(${p1.name}\\)`));
  });

  await t.test('„Vyvolať ďalšieho“ berie len pacientov vlastného pracoviska; TV ukáže, kto vyvolal prvý', async () => {
    let r = await s1.post('/api/staff/call-next', { roomId: p1.id });
    assert.equal(r.data.ticket.code, '1', 'A (00:05) patrí pripravovni 2, preto ho pripravovňa 1 nevolá');
    r = await s2.post('/api/staff/call-next', { roomId: p2.id });
    assert.equal(r.data.ticket.code, 'A');
    const st = (await pub.get('/api/display/state')).data;
    assert.equal(st.current.code, 'A');
    assert.equal(st.recent[0].code, '1');
    assert.deepEqual(st.queue.map((q) => [q.code, q.roomName]), [['2', p1.name]]);
    const r1 = st.rooms.find((x) => x.id === p1.id);
    assert.ok(r1.lastCallDelayMinutes <= 1, 'pacient prišiel po termíne – jeho meškanie sa nepripíše pracovisku');
  });

  await t.test('v2.2: lekár na dnes a smer šípky pri vyvolaní', async () => {
    assert.equal(p1.direction, 'right');
    assert.equal(p2.direction, 'left');
    let r = await s1.post(`/api/staff/rooms/${p1.id}/doctor`, { name: '' });
    assert.equal(r.status, 400);
    r = await s1.post(`/api/staff/rooms/${p1.id}/doctor`, { name: 'MUDr. Ján Novák' });
    assert.equal(r.status, 200);
    assert.equal((await s1.get('/api/staff/state')).data.doctors[p1.id], 'MUDr. Ján Novák');
    await s1.post('/api/staff/cards', { cardNo: '9', plannedTime: '00:30' });
    let st = (await pub.get('/api/display/state')).data;
    assert.equal(st.rooms.find((x) => x.id === p1.id).doctorName, 'MUDr. Ján Novák');
    assert.equal(st.queue.find((q) => q.code === '9').doctorName, 'MUDr. Ján Novák');
    r = await s1.post(`/api/staff/rooms/${p1.id}/doctor`, { name: 'MUDr. Eva Malá' });   // zmena počas dňa
    const c = await s1.post('/api/staff/call-next', { roomId: p1.id });
    assert.equal(c.data.call.doctorName, 'MUDr. Eva Malá');
    assert.equal(c.data.call.direction, 'right');
    st = (await pub.get('/api/display/state')).data;
    assert.equal(st.current.doctorName, 'MUDr. Eva Malá');
    assert.equal(st.current.direction, 'right');
    r = await admin.put(`/api/admin/rooms/${p2.id}`, { direction: 'hore' });
    assert.equal(r.status, 400);
    r = await admin.put(`/api/admin/rooms/${p2.id}`, { direction: 'straight' });
    assert.equal(r.data.direction, 'straight');
  });

  await t.test('v2.3: mimoriadny oznam', async () => {
    let r = await s2.post('/api/staff/announcement', { text: 'Z technických príčin dnes neordinujeme od 12:00.' });
    assert.equal(r.status, 200);
    let st = (await pub.get('/api/display/state')).data;
    assert.equal(st.announcement.text, 'Z technických príčin dnes neordinujeme od 12:00.');
    assert.equal((await s1.get('/api/staff/state')).data.announcement.text, st.announcement.text, 'vidí ho aj druhá sestra');
    r = await s1.post('/api/staff/announcement', { text: 'x'.repeat(301) });
    assert.equal(r.status, 400);
    r = await pub.post('/api/staff/announcement', { text: 'hack' });
    assert.equal(r.status, 401);
    await s1.post('/api/staff/announcement', { text: null });
    st = (await pub.get('/api/display/state')).data;
    assert.equal(st.announcement, null);
  });

  await t.test('hlásenie meškania (predĺžený výkon) a jeho zrušenie ďalším vyvolaním', async () => {
    let r = await s1.post(`/api/staff/rooms/${p1.id}/delay`, { minutes: 90, text: 'Predĺžený výkon' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    let st = (await pub.get('/api/display/state')).data;
    assert.deepEqual(st.rooms.find((x) => x.id === p1.id).reported.minutes, 90);
    assert.equal(st.rooms.find((x) => x.id === p2.id).reported, null);
    assert.equal(st.longDelayMinutes, 30);
    r = await s1.post(`/api/staff/rooms/${p1.id}/delay`, { minutes: 1000 });
    assert.equal(r.status, 400);
    await s1.post('/api/staff/call-next', { roomId: p1.id });
    st = (await pub.get('/api/display/state')).data;
    assert.equal(st.rooms.find((x) => x.id === p1.id).reported, null, 'po vyvolaní ďalšieho pacienta sa hlásenie zruší');
    r = await pub.post(`/api/staff/rooms/${p1.id}/delay`, { minutes: 30 });
    assert.equal(r.status, 401);
  });
});
