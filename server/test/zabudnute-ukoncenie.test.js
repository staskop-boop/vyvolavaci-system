'use strict';
// 2026-11-27 (Pali): keď niekto zabudne pacienta ukončiť, po 2 hodinách ho server ukončí sám,
// upozorní, kto zabudol, a v štatistike sa to ráta ako „zabudnuté ukončenie“.
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
const later = (min) => new Date(Date.now() + min * 60000).toISOString();

test('pacient na ukončení u sestry sa po 2 h ukončí sám, s upozornením a v štatistike', async () => {
  const a = await admin.post('/api/staff/cards', { cardNo: 'Z1', plannedTime: '23:00', roomId: room.id });
  const id = a.data.ticket.id;
  await admin.post(`/api/staff/tickets/${id}/call`, { roomId: room.id });
  await admin.post(`/api/staff/tickets/${id}/to-doctor`, {});
  await lekar.post(`/api/staff/tickets/${id}/call`, { roomId: room.id });
  await lekar.post(`/api/staff/tickets/${id}/to-final`, {});
  // druhý pacient ostal u lekára (lekár ho neposlal na ukončenie)
  const b = await admin.post('/api/staff/cards', { cardNo: 'Z2', plannedTime: '23:05', roomId: room.id, stage: 'doctor' });
  await lekar.post(`/api/staff/tickets/${b.data.ticket.id}/call`, { roomId: room.id });

  assert.deepEqual(s.store.autoFinish(later(119)), [], 'pred 2 h sa nič nedeje');
  const done = s.store.autoFinish(later(121));
  assert.deepEqual(done.map((d) => d.code).sort(), ['Z1', 'Z2']);
  assert.deepEqual(s.store.autoFinish(later(200)), [], 'druhýkrát nič');

  const st = (await admin.get('/api/staff/state')).data;
  assert.equal(st.tickets.find((t) => t.code === 'Z1').status, 'done');
  assert.equal(st.tickets.find((t) => t.code === 'Z2').status, 'done');
  const z1 = st.autoDone.find((x) => x.code === 'Z1'), z2 = st.autoDone.find((x) => x.code === 'Z2');
  assert.equal(z1.stage, 'final'); assert.match(z1.note, /zabudnuté ukončenie u sestry/);
  assert.equal(z2.stage, 'doctor'); assert.equal(z2.who, 'MUDr. Ján Kúdela'); assert.match(z2.note, /lekár neposlal/);

  const day = st.day;
  const doc = (await admin.get(`/api/admin/stats?from=${day}&to=${day}&groupBy=doctor`)).data;
  const k = doc.doctors.find((d) => d.doctor === 'MUDr. Ján Kúdela');
  assert.equal(k.patients, 2); assert.equal(k.done, 2);
  assert.equal(k.forgot, 1, 'lekárovi sa ráta len pacient, ktorého neposlal na ukončenie');
  assert.ok(k.avgExam == null || k.avgExam < 60, 'čas automaticky ukončeného (2 h) sa do priemeru nepočíta');
  const room1 = (await admin.get(`/api/admin/stats?from=${day}&to=${day}&groupBy=room`)).data.total;
  assert.equal(room1.forgot, 2);
  const hist = (await admin.get('/api/staff/history?day=' + day)).data;
  assert.ok(hist.events.some((e) => e.type === 'auto_done'), 'je v histórii');
});

test('čakajúci a ukončení pacienti sa nedotknú', async () => {
  const a = await admin.post('/api/staff/cards', { cardNo: 'Z3', plannedTime: '23:20', roomId: room.id });
  assert.deepEqual(s.store.autoFinish(later(600)), []);
  assert.equal((await admin.get('/api/staff/state')).data.tickets.find((t) => t.code === 'Z3').status, 'waiting');
  await admin.post(`/api/staff/tickets/${a.data.ticket.id}/done`, {});
});
