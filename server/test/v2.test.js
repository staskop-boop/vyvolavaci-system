'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { freshDataDir, start, client, setupAndLogin } = require('./helpers');

freshDataDir();

const RSS = `<?xml version="1.0"?><rss><channel><title>X</title>
<item><title><![CDATA[Vláda schválila nový &bdquo;rozpočet&ldquo; na rok 2027]]></title><pubDate>${new Date().toUTCString()}</pubDate></item>
<item><title>Pri nehode zahynul vodič autobusu</title><pubDate>${new Date().toUTCString()}</pubDate></item>
<item><title>Starý článok spred týždňa o počasí</title><pubDate>${new Date(Date.now() - 7 * 864e5).toUTCString()}</pubDate></item>
</channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">Scientists find water on a distant moon</title><updated>${new Date().toISOString()}</updated></entry>
<entry><title>Vláda schválila nový „rozpočet“ na rok 2027</title><updated>${new Date().toISOString()}</updated></entry></feed>`;

test('v2: kartička s plánovaným časom, poradie, obrazovka a správy', async (t) => {
  const feeds = http.createServer((req, res) => {
    if (req.url === '/rss') { res.setHeader('Content-Type', 'application/rss+xml'); return res.end(RSS); }
    if (req.url === '/atom') { res.setHeader('Content-Type', 'application/atom+xml'); return res.end(ATOM); }
    res.statusCode = 500; res.end('x');
  });
  await new Promise((r) => feeds.listen(0, '127.0.0.1', r));
  const fb = `http://127.0.0.1:${feeds.address().port}`;

  const s = await start();
  t.after(async () => { await s.close(); feeds.close(); });
  const c = await setupAndLogin(s);
  const pub = client(s.base);

  await t.test('zaradenie kartičky a validácia', async () => {
    let r = await c.post('/api/staff/cards', { cardNo: ' 7 ', plannedTime: '23:50' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.ticket.code, '7');
    assert.equal(r.data.ticket.source, 'card');
    assert.ok(r.data.ticket.plannedAt);
    r = await c.post('/api/staff/cards', { cardNo: '7', plannedTime: '10:00' });
    assert.equal(r.status, 409, 'tá istá kartička nemôže čakať dvakrát');
    assert.match(r.data.error.message, /Označenie 7 je už v zozname/);
    r = await c.post('/api/staff/cards', { cardNo: 'A-1', plannedTime: '10:00' });
    assert.equal(r.status, 400);
    r = await c.post('/api/staff/cards', { cardNo: 'b' });
    assert.equal(r.status, 201, 'samotné písmeno');
    assert.equal(r.data.ticket.code, 'B');
    r = await c.post('/api/staff/cards', { cardNo: '1234567' });
    assert.equal(r.status, 400, 'najviac 6 znakov');
    r = await c.post('/api/staff/cards', { cardNo: '8', plannedTime: '25:00' });
    assert.equal(r.status, 400);
    r = await c.post('/api/staff/cards', { cardNo: 'k12', plannedTime: '0:05' });
    assert.equal(r.status, 201);
    assert.equal(r.data.ticket.code, 'K12');
    r = await pub.post('/api/staff/cards', { cardNo: '9' });
    assert.equal(r.status, 401, 'bez prihlásenia nie');
  });

  await t.test('obrazovka: na rade podľa plánovaného času, bez osobných údajov', async () => {
    const st = (await pub.get('/api/display/state')).data;
    assert.deepEqual(st.queue.map((q) => q.code), ['K12', 'B', '7']);
    assert.equal(st.waitingCount, 3);
    assert.ok(st.serverTime);
    assert.equal(typeof st.clinicDelayMinutes, 'number');
    for (const q of st.queue) assert.deepEqual(Object.keys(q).sort(), ['code', 'doctorName', 'plannedAt', 'roomId', 'roomName']);
  });

  await t.test('vyvolať ďalšieho = najskôr plánovaný; sklz ambulancie', async () => {
    const rooms = (await c.get('/api/admin/rooms')).data.rooms;
    const r = await c.post('/api/staff/call-next', { roomId: rooms[0].id });
    assert.equal(r.data.ticket.code, 'K12');
    const st = (await pub.get('/api/display/state')).data;
    assert.equal(st.current.code, 'K12');
    assert.deepEqual(st.queue.map((q) => q.code), ['B', '7']);
    assert.ok(st.clinicDelayMinutes > 0, 'K12 bol plánovaný na 0:05, vyvolaný neskôr → meškanie');
  });

  await t.test('spárovanie času s číslom z tabletu', async () => {
    const k = await pub.post('/api/kiosk/tickets', { requestId: 'req-v2-000001' });
    const id = k.data.ticket.id;
    let r = await c.post(`/api/staff/tickets/${id}/planned`, { plannedTime: '9:15' });
    assert.equal(r.status, 200);
    assert.ok(r.data.ticket.plannedAt);
    r = await c.post(`/api/staff/tickets/${id}/planned`, { plannedTime: null });
    assert.equal(r.data.ticket.plannedAt, null);
  });

  await t.test('nastavenia v2', async () => {
    let r = await c.put('/api/admin/settings', { tvSource: 'javascript:alert(1)' });
    assert.equal(r.status, 400);
    r = await c.put('/api/admin/settings', { tvSource: 'https://webtv.sk/', queueCount: 6, onTimeMinutes: 5,
      news: { feeds: [{ name: 'Test RSS', url: fb + '/rss' }, { name: 'Test Atom', url: fb + '/atom' }, { name: 'Pokazený', url: fb + '/zle' }] } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const st = (await pub.get('/api/display/state')).data;
    assert.equal(st.tvSource, 'https://webtv.sk/');
    assert.equal(st.onTimeMinutes, 5);
  });

  await t.test('správy: RSS + Atom, filter tém, duplicity, starý obsah, chybný zdroj', async () => {
    const r = await c.post('/api/admin/news/refresh', {});
    assert.equal(r.status, 200);
    const bad = r.data.feeds.find((f) => f.name === 'Pokazený');
    assert.equal(bad.ok, false);
    const n = (await pub.get('/api/display/news')).data;
    const titles = n.items.map((i) => i.title);
    assert.ok(titles.includes('Vláda schválila nový „rozpočet“ na rok 2027'), titles.join(' | '));
    assert.ok(titles.includes('Scientists find water on a distant moon'));
    assert.equal(titles.filter((x) => x.startsWith('Vláda')).length, 1, 'duplicita z dvoch zdrojov iba raz');
    assert.ok(!titles.some((x) => /zahynul/.test(x)), 'nevhodná téma vyradená');
    assert.ok(!titles.some((x) => /Starý článok/.test(x)), 'staré správy vyradené');
    assert.deepEqual(Object.keys(n.items[0]).sort(), ['at', 'source', 'tag', 'title']);
  });
});
