'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./helpers');
h.freshDataDir();
const clock = require('../src/clock');
const { dayOf } = clock;

let s, staff, kiosk;
before(async () => { s = await h.start({ kioskRateLimit: 100000 }); staff = await h.setupAndLogin(s); kiosk = h.client(s.base); });
after(() => { clock.setOffset(0); return s.close(); });

const reg = () => kiosk.post('/api/kiosk/tickets', { requestId: crypto.randomUUID() });

test('deň sa určuje podľa Europe/Bratislava (aj okolo polnoci a zmeny času)', () => {
  assert.equal(dayOf(new Date('2026-11-01T22:59:59Z')), '2026-11-01'); // 23:59:59 CET
  assert.equal(dayOf(new Date('2026-11-01T23:00:00Z')), '2026-11-02'); // 00:00 CET
  assert.equal(dayOf(new Date('2026-07-01T21:59:59Z')), '2026-07-01'); // 23:59:59 CEST
  assert.equal(dayOf(new Date('2026-07-01T22:00:00Z')), '2026-07-02');
});

test('nový deň: číslovanie od A001, staré nevybavené čísla ostanú len v histórii', async () => {
  const a = await reg(); await reg(); await reg();
  const st = (await staff.get('/api/staff/state')).data;
  await staff.post('/api/staff/call-next', { roomId: st.rooms[0].id });
  const day1 = st.day;
  // posun hodín o 1 deň
  clock.setOffset(24 * 3600_000);
  s.store.tick();
  // relácia platí 12 h, po posune o deň sa sestra prihlási znova
  assert.equal((await staff.get('/api/staff/state')).status, 401);
  await staff.post('/api/auth/login', { password: 'Testovacie-heslo-1' });
  const n = await reg();
  assert.equal(n.data.ticket.code, 'A001');
  assert.notEqual(n.data.ticket.day, day1);
  const st2 = (await staff.get('/api/staff/state')).data;
  assert.deepEqual(st2.tickets.map((t) => t.code), ['A001'], 'staré čísla sa neprenášajú');
  assert.deepEqual(st2.previousDayOpen, { day: day1, count: 3 }, 'personál je upozornený na nevybavené čísla');
  assert.equal((await kiosk.get('/api/display/state')).data.current, null, 'obrazovka začína nový deň uvítaním');
  const old = await staff.post(`/api/staff/tickets/${a.data.ticket.id}/call`, { roomId: st.rooms[0].id });
  assert.equal(old.status, 409);
  const hist = (await staff.get('/api/staff/history?day=' + day1)).data;
  assert.equal(hist.tickets.length, 3);
  assert.ok(hist.events.some((e) => e.type === 'call'));
  const days = (await staff.get('/api/staff/days')).data.days;
  assert.equal(days.length, 2);
  // vymazanie histórie: zostane len dnešok
  const p = await staff.post('/api/admin/purge', { confirm: 'VYMAZAŤ', password: 'Testovacie-heslo-1', scope: 'history' });
  assert.equal(p.data.deleted, 3);
  assert.equal((await staff.get('/api/staff/days')).data.days.length, 1);
});
