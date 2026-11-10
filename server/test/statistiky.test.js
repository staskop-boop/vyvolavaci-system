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

test('štatistiky lekárov: lekár sa ukladá pri vyvolaní, čakanie, meškanie a dĺžka vyšetrenia', async () => {
  const st = (await admin.get('/api/staff/state')).data;
  const [r1, r2] = st.rooms;
  await admin.post(`/api/staff/rooms/${r1.id}/doctor`, { name: 'MUDr. Test Prvý' });
  await admin.post(`/api/staff/rooms/${r2.id}/doctor`, { name: 'MUDr. Test Druhý' });
  const a = await reg(); const b = await reg(); const c = await reg();
  await admin.post(`/api/staff/tickets/${a.id}/call`, { roomId: r1.id });
  await admin.post(`/api/staff/tickets/${a.id}/done`);
  await admin.post(`/api/staff/tickets/${b.id}/call`, { roomId: r1.id });
  await admin.post(`/api/staff/tickets/${b.id}/absent`);
  await admin.post(`/api/staff/tickets/${c.id}/call`, { roomId: r2.id });
  // presné časy pre overenie výpočtov
  const db = s.store.db; const t0 = new Date(Date.now() - 3 * 3600_000).toISOString();
  db.prepare('UPDATE tickets SET created_at = ?, planned_at = ?, finished_at = ? WHERE id = ?').run(t0, iso(t0, 10), iso(t0, 50), a.id);
  db.prepare("UPDATE ticket_events SET at = ? WHERE ticket_id = ? AND type = 'call'").run(iso(t0, 30), a.id);
  db.prepare('UPDATE tickets SET created_at = ?, planned_at = NULL WHERE id = ?').run(t0, b.id);
  db.prepare("UPDATE ticket_events SET at = ? WHERE ticket_id = ? AND type = 'call'").run(iso(t0, 10), b.id);

  const day = st.day;
  const r = await admin.get(`/api/admin/stats?from=${day}&to=${day}`);
  assert.equal(r.status, 200);
  const prvy = r.data.doctors.find((d) => d.doctor === 'MUDr. Test Prvý');
  assert.equal(prvy.patients, 2); assert.equal(prvy.done, 1); assert.equal(prvy.absent, 1);
  assert.equal(prvy.avgWait, 20, 'čakanie (30 + 10) / 2');
  assert.equal(prvy.planned, 1); assert.equal(prvy.avgDelay, 20, 'vyvolaný 20 min po plánovanom čase');
  assert.equal(prvy.onTime, 0); assert.equal(prvy.late15, 1);
  assert.equal(prvy.avgExam, 20, 'od vyvolania po vybavenie');
  const druhy = r.data.doctors.find((d) => d.doctor === 'MUDr. Test Druhý');
  assert.equal(druhy.patients, 1); assert.equal(druhy.open, 1);
  assert.equal(r.data.total.patients, 3);
  assert.equal(r.data.doctorDataSince, day);

  assert.equal((await admin.get('/api/admin/stats?from=x&to=y')).status, 400);
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

test('uzavretie nevybavených čísel staršieho dňa', async () => {
  const day1 = (await admin.get('/api/staff/state')).data.day;
  assert.equal((await admin.post('/api/staff/close-past-day', { day: day1 })).status, 400, 'dnešok sa takto neuzatvára');
  await reg();
  clock.setOffset(24 * 3600_000); s.store.tick();
  await admin.post('/api/auth/login', { username: 'personal', password: 'Testovacie-heslo-1' });
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
