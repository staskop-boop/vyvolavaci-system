'use strict';
// Meškanie: pacient, ktorý príde po svojom termíne, mešká sám – jeho meškanie sa nepripíše ambulancii ani ostatným.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
h.freshDataDir();
const clock = require('../src/clock');

let s, staff;
before(async () => { s = await h.start(); staff = await h.setupAndLogin(s); });
after(() => { clock.setOffset(0); return s.close(); });

const hm = (minFromNow) => new Intl.DateTimeFormat('sk-SK', { timeZone: 'Europe/Bratislava', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .format(new Date(clock.now().getTime() + minFromNow * 60000));

test('neskorý príchod nezvýši sklz ambulancie; čakanie po termíne áno', async (t) => {
  if (new Date(clock.now().getTime() - 55 * 60000).getDate() !== new Date(clock.now().getTime() + 50 * 60000).getDate()) return t.skip('okolo polnoci');
  await staff.post('/api/staff/cards', { cardNo: '5', plannedTime: hm(10) });    // prišiel o 10 min skôr
  await staff.post('/api/staff/cards', { cardNo: '6', plannedTime: hm(-50) });   // prišiel o 50 min neskôr
  const st = (await staff.get('/api/staff/state')).data;
  const id = (c) => st.tickets.find((x) => x.code === c).id;
  const room = st.rooms[0].id;

  let d = (await staff.get('/api/display/state')).data;
  const q6 = d.queue.find((q) => q.code === '6');
  assert.ok(Date.parse(q6.arrivedAt) - Date.parse(q6.plannedAt) >= 49 * 60000, 'TV vie, že 6 prišiel neskoro');

  clock.setOffset(5 * 60000);
  assert.equal((await staff.post(`/api/staff/tickets/${id('6')}/call`, { roomId: room })).status, 200);
  d = (await staff.get('/api/display/state')).data;
  let r = d.rooms.find((x) => x.id === room).lastCallDelayMinutes;
  assert.ok(r >= 4 && r <= 6, `6 vyvolaný 5 min po príchode → sklz ~5 min, nie 55 (je ${r})`);
  assert.ok(d.clinicDelayMinutes <= 6);

  clock.setOffset(40 * 60000);
  await staff.post(`/api/staff/tickets/${id('6')}/done`, {});
  assert.equal((await staff.post(`/api/staff/tickets/${id('5')}/call`, { roomId: room })).status, 200);
  d = (await staff.get('/api/display/state')).data;
  r = d.rooms.find((x) => x.id === room).lastCallDelayMinutes;
  assert.ok(r >= 29 && r <= 31, `5 prišiel včas a čakal 30 min po termíne → sklz ~30 min (je ${r})`);
});

test('po „vybavený“ ambulancia na TV nikoho nevyšetruje', async () => {
  const st = (await staff.get('/api/staff/state')).data;
  const room = st.rooms[0].id;
  let d = (await staff.get('/api/display/state')).data;
  assert.equal(d.rooms.find((x) => x.id === room).current, '5');
  await staff.post(`/api/staff/tickets/${st.tickets.find((x) => x.code === '5').id}/done`, {});
  d = (await staff.get('/api/display/state')).data;
  const r = d.rooms.find((x) => x.id === room);
  assert.equal(r.current, null);
  assert.equal(r.calledToday, true, 'ambulancia ostáva na TV ako „Pripravujeme ďalšieho pacienta“');
});
