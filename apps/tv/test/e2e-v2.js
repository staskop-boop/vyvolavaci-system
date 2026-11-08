// E2E test obrazovky v2 (TV program + panel „Na rade“ + lišta správ). Spustenie: node apps/tv/test/e2e-v2.js
'use strict';
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SHOTS = process.env.ADNA_SHOTS || path.join(os.tmpdir(), 'adna-shots');
const PORT = Number(process.env.ADNA_TEST_PORT || 8184);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'Testovacie-heslo-TV2-1';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adna-tv2-e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc = null, ok = 0;
async function step(name, fn) { try { await fn(); ok++; console.log('OK   ' + name); } catch (e) { console.log('FAIL ' + name + '\n     ' + e.message); throw e; } }

// Ukážkové RSS (cloud nemá prístup k médiám – na reálnom serveri sa použijú skutočné kanály)
const now = new Date().toUTCString();
const item = (t) => `<item><title>${t}</title><pubDate>${now}</pubDate></item>`;
const FEEDS = {
  '/tasr': ['Košice dostanú nové električkové spojenie do Šace', 'Na východe Slovenska sa otepľuje, cez víkend až 14 stupňov', 'Slovenskí vedci vyvinuli nový test na včasné odhalenie trombózy'],
  '/sme': ['Tatranská lanovka spúšťa zimnú sezónu skôr ako po minulé roky', 'Slovensko postúpilo na majstrovstvá Európy v hádzanej'],
  '/bbc': ['NASA confirms launch window for next crewed Moon mission', 'Scientists map the deepest coral reef ever discovered'],
};
const feeds = http.createServer((req, res) => { const f = FEEDS[req.url]; if (!f) { res.statusCode = 404; return res.end(); } res.end(`<rss><channel>${f.map(item).join('')}</channel></rss>`); });

let cookie = '';
async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(d)}`);
  return d;
}
const hm = (minFromNow) => new Intl.DateTimeFormat('sk-SK', { timeZone: 'Europe/Bratislava', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.now() + minFromNow * 60000));

(async () => {
  await new Promise((r) => feeds.listen(0, '127.0.0.1', r));
  const fb = `http://127.0.0.1:${feeds.address().port}`;
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server/src/index.js')], {
    env: { ...process.env, ADNA_PORT: String(PORT), ADNA_DATA_DIR: dataDir, ADNA_QUIET: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(100); }
  const code = fs.readFileSync(path.join(dataDir, 'SETUP-KOD.txt'), 'utf8').match(/KOD:\s*(\S+)/)[1];
  await api('POST', '/api/setup', { setupCode: code, password: PASSWORD });
  await api('POST', '/api/auth/login', { username: 'personal', password: PASSWORD });
  await api('PUT', '/api/admin/settings', { news: { feeds: [{ name: 'TASR', url: fb + '/tasr' }, { name: 'SME', url: fb + '/sme' }, { name: 'BBC', url: fb + '/bbc' }] } });
  await api('POST', '/api/admin/news/refresh', {});
  const rooms = (await api('GET', '/api/staff/state')).rooms;
  fs.mkdirSync(SHOTS, { recursive: true });

  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/obrazovka/');
  await page.waitForFunction(() => window.__adnaTest.states > 0);

  await step('prázdna obrazovka: ambulancie, TV zóna, lišta správ', async () => {
    assert.ok(await page.locator('#roomsCard').isVisible());
    assert.ok(await page.locator('#tvPlaceholder').isVisible());
    await page.waitForFunction(() => (window.__adnaTest.newsItems || 0) >= 5, null, { timeout: 5000 });
    const t = await page.locator('#tickerMove').innerText();
    assert.match(t, /TASR/); assert.match(t, /BBC/);
    await page.screenshot({ path: path.join(SHOTS, 'tv2-1-uvitanie.png') });
  });

  // pacienti s kartičkami: dvaja „po termíne“, jeden načas, dvaja s termínom neskôr
  const cards = [['3', -50], ['12', -38], ['7', -20], ['15', -6], ['21', 2], ['4', 25], ['9', 40]];
  for (const [c, m] of cards) await api('POST', '/api/staff/cards', { cardNo: c, plannedTime: hm(m) });
  await api('POST', '/api/staff/cards', { cardNo: 'A' });                    // písmeno, bez termínu

  await step('vyvolanie: číslo kartičky + ambulancia v karte „Vyvolávame“ a v banneri cez TV; zvuk', async () => {
    const before = await page.evaluate(() => window.__adnaTest.chimes);
    await api('POST', '/api/staff/call-next', { roomId: rooms[0].id });    // 3 (−50 min) → ambulancia mešká ~50 min
    await api('POST', '/api/staff/call-next', { roomId: rooms[1].id });    // 12
    await page.waitForFunction(() => document.getElementById('callCode').textContent === '12', null, { timeout: 12000 });
    assert.deepEqual(await page.evaluate(() => window.__adnaTest.shown.slice(-2)), ['3', '12'], 'dve výzvy po sebe, nie naraz');
    assert.equal(await page.locator('#callRoom').innerText(), rooms[1].name);
    assert.ok(await page.locator('#tvCall').isVisible());
    assert.match(await page.locator('#tvCallTitle').innerText(), /číslom 12, prosíme, vstúpte/);
    assert.ok((await page.evaluate(() => window.__adnaTest.chimes)) > before);
    await sleep(400);
    await page.screenshot({ path: path.join(SHOTS, 'tv2-2-vyvolanie.png') });
  });

  await step('na rade: poradie podľa termínu (bez termínu = podľa príchodu), meškanie červené', async () => {
    const rows = await page.$$eval('#queueList li', (l) => l.map((li) => ({ code: li.querySelector('.c-code').textContent, cls: li.querySelector('.c-delta').className, d: li.dataset.delta })));
    assert.deepEqual(rows.map((r) => r.code), ['7', '15', 'A', '21', '4', '9']);
    assert.ok(rows.filter((r) => r.code !== 'A').every((r) => /late/.test(r.cls)), 'ambulancia mešká ~38 min → všetci s termínom červení');
    assert.match(rows[2].cls, /none/);
  });

  await step('ambulancia dobieha: predstih zelenou', async () => {
    await api('PUT', '/api/admin/settings', { ticketDisplaySeconds: 5 }); await sleep(400);
    // sestra vyvolá pacienta s termínom o 25 min (4) mimo poradia → ambulancia je ~25 min vpred
    const st = await api('GET', '/api/staff/state');
    const t4 = st.tickets.find((t) => t.code === '4');
    const t7 = st.tickets.find((t) => t.code === '7');
    const t15 = st.tickets.find((t) => t.code === '15');
    await api('POST', `/api/staff/tickets/${t7.id}/done`, {}).catch(() => {});
    await api('POST', `/api/staff/tickets/${t7.id}/absent`, {}).catch(() => {});
    await api('POST', `/api/staff/tickets/${t15.id}/absent`, {});
    await api('POST', `/api/staff/tickets/${t4.id}/call`, { roomId: rooms[0].id });
    await page.waitForFunction(() => document.getElementById('callCode').textContent === '4');
    await page.waitForFunction(() => ![...document.querySelectorAll('#queueList .c-code')].some((c) => ['7', '15'].includes(c.textContent)));
    const rows = await page.$$eval('#queueList li', (l) => l.map((li) => [li.querySelector('.c-code').textContent, li.querySelector('.c-delta').className]));
    const r9 = rows.find((r) => r[0] === '9');
    assert.match(r9[1], /early/, JSON.stringify(rows));
    const r21 = rows.find((r) => r[0] === '21');
    assert.match(r21[1], /early|ontime/, JSON.stringify(rows));
        await page.waitForFunction(() => document.getElementById('tvCall').classList.contains('hidden'), null, { timeout: 8000 });
    await page.screenshot({ path: path.join(SHOTS, 'tv2-3-na-rade-predstih.png') });
  });

  await step('rozloženie: obraz TV ~ 16 : 9, poloha pre okno prehrávača', async () => {
    const L = await page.evaluate(() => window.AdNaLayout.tv);
    assert.ok(L.width > 1200 && L.height > 650 && Math.abs(L.width / L.height - 16 / 9) < 0.08, JSON.stringify(L));
  });

  await step('režim pre okno prehrávača (?zona=prazdna) a 1280×720', async () => {
    const p2 = await b.newPage({ viewport: { width: 1280, height: 720 } });
    await p2.goto(BASE + '/obrazovka/?zona=prazdna');
    await p2.waitForFunction(() => window.__adnaTest.states > 0);
    assert.ok(!(await p2.locator('#tvPlaceholder').isVisible()));
    await sleep(500);
    await p2.screenshot({ path: path.join(SHOTS, 'tv2-4-720p-prazdna-zona.png') });
    await p2.close();
  });

  await step('vložený prehrávač (tvSource) sa zobrazí v TV zóne', async () => {
    await api('PUT', '/api/admin/settings', { tvSource: BASE + '/shared/index.html' });
    await page.waitForSelector('#tvVideo iframe', { timeout: 5000 });
    await api('PUT', '/api/admin/settings', { tvSource: '' });
    await page.waitForFunction(() => !document.querySelector('#tvZone iframe'));
  });

  await step('sestra: tlačidlo „+ Pacient“ zaradí pacienta s písmenom aj číslom a časom', async () => {
    const ps = await b.newPage({ viewport: { width: 1600, height: 1000 } });
    await ps.goto(BASE + '/sestra/');
    await ps.fill('#pw', PASSWORD); await ps.keyboard.press('Enter');
    await ps.locator('#m-doc').waitFor(); await ps.click('#m-cancel'); // v2.2: výzva na lekára dňa – tu „Neskôr“
    await ps.waitForSelector('#btn-card');
    await ps.click('#btn-card');
    await ps.fill('#m-card', '44'); await ps.fill('#m-time', hm(-10));
    await ps.click('#m-ok');
    await ps.waitForFunction(() => document.getElementById('tbl-waiting') && document.getElementById('tbl-waiting').innerText.includes('44'));
    await ps.screenshot({ path: path.join(SHOTS, 'sestra2-zoznam-terminy.png') });
    await ps.click('#btn-card');
    await ps.fill('#m-card', '44'); await ps.fill('#m-time', hm(0)); await ps.click('#m-ok');
    await ps.waitForFunction(() => /Označenie 44 je už v zozname/.test(document.getElementById('m-err').textContent));
    await ps.fill('#m-card', 'k'); await ps.fill('#m-time', ''); await ps.click('#m-ok');
    await ps.waitForFunction(() => /Zadajte čas objednania/.test(document.getElementById('m-err').textContent));
    await ps.fill('#m-time', hm(5)); await ps.click('#m-ok');
    await ps.waitForFunction(() => document.getElementById('tbl-waiting').innerText.includes('K'));
    await ps.screenshot({ path: path.join(SHOTS, 'sestra2-karticka-duplicita.png') });
    await ps.close();
    await page.waitForFunction(() => document.getElementById('queueList').innerText.includes('44'));
  });

  await step('bez chýb JavaScriptu', async () => { assert.deepEqual(errors, []); });

  await b.close();
  proc.kill('SIGTERM'); feeds.close();
  console.log(`\nVýsledok: ${ok} OK`);
  process.exit(0);
})().catch((e) => { console.error(e); if (proc) proc.kill('SIGTERM'); process.exit(1); });
