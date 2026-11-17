'use strict';
// 2026-11-17 (Pali): hlasitosť vyvolania, „Ukončiť deň“ a „dnes v tejto ambulancii neordinuje nikto“
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { freshDataDir, start, client, setupAndLogin } = require('./helpers');

freshDataDir();

let s, admin;
before(async () => { s = await start({ kioskRateLimit: 100000 }); admin = await setupAndLogin(s); });
after(() => s.close());

const rid = () => 'req-' + Math.random().toString(36).slice(2, 12);

test('hlasitosť vyvolania: nastavenie, obrazovka a skúška na TV', async (t) => {
  const pub = client(s.base);
  assert.equal((await pub.get('/api/display/state')).data.soundVolume, 150, 'predvolene hlasnejšie ako pôvodných 100 %');
  assert.equal((await admin.put('/api/admin/settings', { soundVolume: 250 })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { soundVolume: 5 })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { soundVolume: 180 })).status, 200);
  assert.equal((await pub.get('/api/display/state')).data.soundVolume, 180);

  // skúška hlasitosti príde obrazovke cez WebSocket
  const ws = new WebSocket(s.base.replace('http', 'ws') + '/ws?channel=display');
  const msgs = [];
  ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
  await new Promise((r) => ws.on('open', r));
  t.after(() => ws.close());
  const r = await admin.post('/api/admin/sound-test', { volume: 120 });
  assert.equal(r.status, 200);
  assert.equal(r.data.screens, 1);
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(msgs.some((m) => m.type === 'sound.test' && m.volume === 120));
  assert.equal((await admin.post('/api/admin/sound-test', { volume: 300 })).status, 400);
  assert.equal((await pub.post('/api/admin/sound-test', { volume: 100 })).status, 401);
});

test('Ukončiť deň: tablet nevydá číslo, TV a Sestra to vedia, dá sa obnoviť', async (t) => {
  const pub = client(s.base);
  assert.equal((await pub.post('/api/kiosk/tickets', { requestId: rid() })).status, 201);
  assert.equal((await pub.get('/api/display/state')).data.dayEnd, null);

  let r = await admin.post('/api/staff/day-end', { ended: true });
  assert.equal(r.status, 200);
  assert.ok(r.data.dayEnd.at);
  const d = (await pub.get('/api/display/state')).data;
  assert.ok(d.dayEnd, 'TV ukáže oznam');
  assert.equal(d.waitingCount, 1, 'čakajúci ostávajú');
  assert.equal((await pub.get('/api/public/config')).data.dayEnded, true);
  assert.ok((await admin.get('/api/staff/state')).data.dayEnd);

  r = await pub.post('/api/kiosk/tickets', { requestId: rid() });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'DAY_ENDED');
  // čakajúceho sa dá stále vyvolať
  const room = (await admin.get('/api/staff/state')).data.rooms[0];
  assert.equal((await admin.post('/api/staff/call-next', { roomId: room.id })).status, 200);

  // lekárske konto deň neukončuje (robí to sestra)
  await admin.post('/api/admin/users', { username: 'lekar1', password: 'Heslo-lekara-01', role: 'staff', doctorName: 'MUDr. Test Lekár' });
  const lekar = client(s.base);
  await lekar.post('/api/auth/login', { username: 'lekar1', password: 'Heslo-lekara-01' });
  assert.equal((await lekar.post('/api/staff/day-end', { ended: false })).status, 403);

  assert.equal((await admin.post('/api/staff/day-end', { ended: false })).status, 200);
  assert.equal((await pub.get('/api/display/state')).data.dayEnd, null);
  assert.equal((await pub.post('/api/kiosk/tickets', { requestId: rid() })).status, 201);
});

test('ambulancia, v ktorej dnes neordinuje nikto, sa na TV nezobrazuje', async (t) => {
  const pub = client(s.base);
  const rooms = (await admin.get('/api/staff/state')).data.rooms.filter((r) => r.active);
  const [a1, a2] = rooms;
  await admin.post(`/api/staff/rooms/${a2.id}/doctor`, { name: 'MUDr. Test Druhý' });

  let r = await admin.post(`/api/staff/rooms/${a2.id}/closed`, { closed: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.roomsClosed, [a2.id]);
  let st = (await admin.get('/api/staff/state')).data;
  assert.deepEqual(st.roomsClosed, [a2.id]);
  assert.equal(st.doctors[a2.id], undefined, 'lekár zatvorenej ambulancie sa zruší');
  let d = (await pub.get('/api/display/state')).data;
  assert.equal(d.rooms.find((x) => x.id === a2.id).closedToday, true);
  assert.equal(d.rooms.find((x) => x.id === a1.id).closedToday, false);

  // všetky ambulancie zavrieť nemožno – na to je Ukončiť deň
  for (const x of rooms.slice(2)) assert.equal((await admin.post(`/api/staff/rooms/${x.id}/closed`, { closed: true })).status, 200);
  r = await admin.post(`/api/staff/rooms/${a1.id}/closed`, { closed: true });
  assert.equal(r.status, 409);
  assert.match(r.data.error.message, /Ukončiť deň/);

  // zadaním lekára ambulancia opäť ordinuje
  await admin.post(`/api/staff/rooms/${a2.id}/doctor`, { name: 'MUDr. Test Druhý' });
  d = (await pub.get('/api/display/state')).data;
  assert.equal(d.rooms.find((x) => x.id === a2.id).closedToday, false);

  // vyvolaním do zatvorenej ambulancie sa tiež otvorí
  await admin.post(`/api/staff/rooms/${a2.id}/closed`, { closed: true });
  await admin.post('/api/staff/cards', { cardNo: '7', plannedTime: '08:00', roomId: null });
  assert.equal((await admin.post('/api/staff/call-next', { roomId: a2.id })).status, 200);
  assert.equal((await pub.get('/api/display/state')).data.rooms.find((x) => x.id === a2.id).closedToday, false);

  // výslovné otvorenie
  await admin.post(`/api/staff/rooms/${a2.id}/closed`, { closed: true });
  await admin.post(`/api/staff/rooms/${a2.id}/closed`, { closed: false });
  assert.ok(!(await admin.get('/api/staff/state')).data.roomsClosed.includes(a2.id));
});
