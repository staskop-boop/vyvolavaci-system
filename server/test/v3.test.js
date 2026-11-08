'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { freshDataDir, start, client, setupAndLogin } = require('./helpers');
freshDataDir();
const { wmo } = require('../src/weather');   // až po freshDataDir (načíta konfiguráciu)

test('v3: dizajn obrazovky – počasie, číslo v každej ambulancii, nastavenia hlavičky', async (t) => {
  let asked = null;
  const weatherFetch = async (url) => {
    asked = url;
    return { ok: true, json: async () => ({
      current: { temperature_2m: 8.6, weather_code: 2 },
      daily: { time: ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11'], weather_code: [2, 3, 61, 71],
        temperature_2m_max: [10, 11.4, 8, 2], temperature_2m_min: [3, 4, 2.6, -1] },
    }) };
  };
  const s = await start({ weatherFetch });
  t.after(() => s.close());
  const admin = await setupAndLogin(s);
  const pub = client(s.base);

  await t.test('počasie z Open-Meteo, ikona a popis podľa WMO kódu', async () => {
    await s.weather.refresh();
    assert.match(asked, /latitude=48.72&longitude=21.26/);
    const w = (await pub.get('/api/display/weather')).data;
    assert.equal(w.temp, 9); assert.equal(w.icon, 'partly'); assert.equal(w.text, 'Polooblačno'); assert.equal(w.city, 'Košice');
    assert.deepEqual(w.days.map((d) => [d.icon, d.max, d.min]), [['cloudy', 11, 4], ['rain', 8, 3], ['snow', 2, -1]]);
    assert.deepEqual([0, 45, 81, 86, 96].map((c) => wmo(c).icon), ['clear', 'fog', 'rain', 'snow', 'storm']);
  });

  await t.test('výpadok počasia nechá posledný známy stav', async () => {
    s.weather.fetch = async () => { throw new Error('offline'); };
    await s.weather.refresh();
    assert.equal((await pub.get('/api/display/weather')).data.temp, 9);
  });

  await t.test('nastavenia hlavičky a informácií pre pacientov', async () => {
    let r = await admin.put('/api/admin/settings', { screen: { phone: 'Call centrum 0900 000 000', info: ['Prvá **dôležitá** vec.'], weather: { enabled: false } } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const st = (await pub.get('/api/display/state')).data;
    assert.equal(st.screen.phone, 'Call centrum 0900 000 000');
    assert.deepEqual(st.screen.info, ['Prvá **dôležitá** vec.']);
    assert.equal(st.screen.title, 'Ambulancia cievnej chirurgie', 'ostatné hodnoty ostali');
    assert.equal(st.screen.weatherEnabled, false);
    assert.equal((await pub.get('/api/display/weather')).data.temp, undefined, 'vypnuté počasie sa neposiela');
    r = await admin.put('/api/admin/settings', { screen: { theme: 'disco' } });
    assert.equal(r.status, 400);
    r = await admin.put('/api/admin/settings', { screen: { weather: { lat: 500 } } });
    assert.equal(r.status, 400);
  });

  await t.test('„Práve vyšetrujeme“: posledné číslo každej ambulancie zvlášť', async () => {
    const rooms = (await admin.get('/api/admin/rooms')).data.rooms;
    const [a1, a2] = rooms;
    for (const [code, room] of [['5', a1], ['B', a2], ['6', a1]]) {
      const r = await admin.post('/api/staff/cards', { cardNo: code, plannedTime: '23:00', roomId: room.id });
      assert.equal(r.status, 201, JSON.stringify(r.data));
    }
    await admin.post('/api/staff/call-next', { roomId: a1.id });
    await admin.post('/api/staff/call-next', { roomId: a2.id });
    let st = (await pub.get('/api/display/state')).data;
    assert.equal(st.rooms.find((r) => r.id === a1.id).current, '5');
    assert.equal(st.rooms.find((r) => r.id === a2.id).current, 'B');
    assert.equal(st.current.code, 'B');
    assert.equal(st.current.roomId, a2.id);
    await admin.post('/api/staff/call-next', { roomId: a1.id });
    st = (await pub.get('/api/display/state')).data;
    assert.equal(st.rooms.find((r) => r.id === a1.id).current, '6');
    assert.equal(st.rooms.find((r) => r.id === a2.id).current, 'B');
  });
});
