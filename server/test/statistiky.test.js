'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./helpers');
h.freshDataDir();
const clock = require('../src/clock');

let s, admin, kiosk;
before(async () => { s = await h.start({ kioskRateLimit: 100000 }); admin = await h.setupAndLogin(s); kiosk = h.client(s.base); });
after(() => { clock.setOffset(0); return s.close(); });

const reg = async () => (await kiosk.post('/api/kiosk/tickets', { requestId: crypto.randomUUID() })).data.ticket;
const iso = (base, min) => new Date(Date.parse(base) + min * 60000).toISOString();

test('štatistiky: sestra a lekár zvlášť (dva kroky), čakanie, meškanie a dĺžka vyšetrenia', async () => {
  const st = (await admin.get('/api/staff/state')).data;
  const [r1, r2] = st.rooms;
  await admin.post(`/api/staff/rooms/${r1.id}/doctor`, { name: 'MUDr. Test Prvý' });
  await admin.post(`/api/staff/rooms/${r2.id}/doctor`, { name: 'MUDr. Test Druhý' });
  await admin.post(`/api/staff/rooms/${r1.id}/nurse`, { name: 'Daniela Fetyková' });
  const a = await reg(); const b = await reg(); const c = await reg(); const d = await reg();
  // a: sestra → čakáreň → lekár → ukončený
  await admin.post(`/api/staff/tickets/${a.id}/call`, { roomId: r1.id });
  await admin.post(`/api/staff/tickets/${a.id}/to-doctor`, {});
  await admin.post('/api/staff/call-next', { roomId: r1.id, stage: 'doctor' });
  await admin.post(`/api/staff/tickets/${a.id}/done`);
  // b: sestra → priamo k lekárovi → neprítomný
  await admin.post(`/api/staff/tickets/${b.id}/call`, { roomId: r1.id });
  await admin.post(`/api/staff/tickets/${b.id}/to-doctor`, { direct: true });
  await admin.post(`/api/staff/tickets/${b.id}/absent`);
  // c: druhá ambulancia, priamo k lekárovi, ešte u neho
  await admin.post(`/api/staff/tickets/${c.id}/call`, { roomId: r2.id });
  await admin.post(`/api/staff/tickets/${c.id}/to-doctor`, { direct: true });
  // d: ukončený u sestry bez lekára – lekárovi sa nepripíše
  await admin.post(`/api/staff/tickets/${d.id}/call`, { roomId: r1.id });
  await admin.post(`/api/staff/tickets/${d.id}/done`);
  // presné časy pre overenie výpočtov
  const db = s.store.db; const t0 = new Date(Date.now() - 3 * 3600_000).toISOString();
  const ev = (id, type, stage, min) => db.prepare('UPDATE ticket_events SET at = ? WHERE ticket_id = ? AND type = ? AND stage = ?').run(iso(t0, min), id, type, stage);
  db.prepare('UPDATE tickets SET created_at = ?, planned_at = ?, finished_at = ?, to_doctor_at = ? WHERE id = ?').run(t0, iso(t0, 10), iso(t0, 75), iso(t0, 40), a.id);
  ev(a.id, 'call', 'nurse', 30); ev(a.id, 'to_doctor', 'nurse', 40); ev(a.id, 'call', 'doctor', 55);
  db.prepare('UPDATE tickets SET created_at = ?, planned_at = NULL WHERE id = ?').run(t0, b.id);
  ev(b.id, 'call', 'nurse', 10); ev(b.id, 'to_doctor', 'doctor', 20);

  const day = st.day;
  const r = await admin.get(`/api/admin/stats?from=${day}&to=${day}`);
  assert.equal(r.status, 200);
  const prvy = r.data.doctors.find((x) => x.doctor === 'MUDr. Test Prvý');
  assert.equal(prvy.patients, 2, 'pacient ukončený len u sestry sa lekárovi nepočíta'); assert.equal(prvy.done, 1); assert.equal(prvy.absent, 1);
  assert.equal(prvy.avgWait, 8, 'čakanie na lekára (15 + 0) / 2');
  assert.equal(prvy.planned, 0, 'meškanie oproti termínu sa lekárovi pri dvoch krokoch nepripisuje');
  assert.equal(prvy.avgExam, 20, 'u lekára od vyvolania lekárom po ukončenie');
  assert.equal(prvy.avgNurse, 10); assert.equal(prvy.direct, 1); assert.equal(prvy.toDoctor, 2);
  const druhy = r.data.doctors.find((x) => x.doctor === 'MUDr. Test Druhý');
  assert.equal(druhy.patients, 1); assert.equal(druhy.open, 1);
  assert.equal(r.data.total.patients, 3);
  assert.equal(r.data.doctorDataSince, day);
  assert.equal(r.data.twoStepSince, day);

  const n = await admin.get(`/api/admin/stats?from=${day}&to=${day}&groupBy=nurse`);
  const fet = n.data.doctors.find((x) => x.doctor === 'Daniela Fetyková');
  assert.equal(fet.patients, 3, 'a, b aj d boli u sestry');
  assert.equal(fet.planned, 1); assert.equal(fet.avgDelay, 20, 'vstup k sestre 20 min po termíne');
  assert.equal(fet.late15, 1);
  assert.ok(n.data.doctors.some((x) => x.doctor === 'Sestra nebola zadaná'));

  assert.equal((await admin.get('/api/admin/stats?from=x&to=y')).status, 400);
});

test('staršie záznamy bez kroku sa počítajú ako doteraz (všetko lekárovi)', async () => {
  const st = (await admin.get('/api/staff/state')).data;
  const e = await reg();
  await admin.post(`/api/staff/tickets/${e.id}/call`, { roomId: st.rooms[0].id });
  await admin.post(`/api/staff/tickets/${e.id}/done`);
  const db = s.store.db;
  db.prepare("UPDATE ticket_events SET stage = NULL, nurse = NULL, doctor = 'MUDr. Starý Záznam' WHERE ticket_id = ?").run(e.id);
  const r = await admin.get(`/api/admin/stats?from=${st.day}&to=${st.day}`);
  const old = r.data.doctors.find((x) => x.doctor === 'MUDr. Starý Záznam');
  assert.equal(old.patients, 1); assert.equal(old.done, 1);
});

test('štatistiky vidí len správca', async () => {
  const st = (await admin.get('/api/staff/state')).data;
  const u = await admin.post('/api/admin/users', { username: 'sestra1', password: 'Heslo-sestra-01', roomId: st.rooms[0].id });
  assert.equal(u.status, 201);
  const sestra = h.client(s.base);
  assert.equal((await sestra.post('/api/auth/login', { username: 'sestra1', password: 'Heslo-sestra-01' })).status, 200);
  assert.equal((await sestra.get(`/api/admin/stats?from=${st.day}&to=${st.day}`)).status, 403);
  assert.equal((await kiosk.get(`/api/admin/stats?from=${st.day}&to=${st.day}`)).status, 401);
});

test('uzavretie neukončených čísel staršieho dňa', async () => {
  const day1 = (await admin.get('/api/staff/state')).data.day;
  assert.equal((await admin.post('/api/staff/close-past-day', { day: day1 })).status, 400, 'dnešok sa takto neuzatvára');
  await reg();
  clock.setOffset(24 * 3600_000); s.store.tick();
  await admin.post('/api/auth/login', { username: 'admin', password: 'Testovacie-heslo-1' });
  const before = (await admin.get('/api/staff/days')).data.days.find((d) => d.day === day1);
  assert.ok(before.waiting + before.called >= 2);
  const r = await admin.post('/api/staff/close-past-day', { day: day1 });
  assert.equal(r.status, 200);
  assert.equal(r.data.closed, before.waiting + before.called);
  const after = (await admin.get('/api/staff/days')).data.days.find((d) => d.day === day1);
  assert.equal(after.waiting + after.called, 0);
  const hist = (await admin.get('/api/staff/history?day=' + day1)).data;
  assert.ok(hist.events.some((e) => e.type === 'day_closed'));
  assert.equal((await admin.post('/api/staff/close-past-day', { day: 'zly' })).status, 400);
});
