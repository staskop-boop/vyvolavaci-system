// E2E test obrazovky v čakárni (Playwright + Chromium).
// Spustenie: node apps/tv/test/e2e.js
//   – bez ADNA_URL si test spustí vlastný server (dočasná DB) a otestuje aj výpadok a obnovenie servera;
//   – s ADNA_URL=http://server:8080 a ADNA_PASSWORD=... použije existujúci server (bez testu výpadku).
'use strict';
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SHOTS = process.env.ADNA_SHOTS || '/mnt/project-files/adna/screenshots/';
const PORT = Number(process.env.ADNA_TEST_PORT || 8183);
const own = !process.env.ADNA_URL;
const BASE = process.env.ADNA_URL || `http://127.0.0.1:${PORT}`;
const PASSWORD = process.env.ADNA_PASSWORD || 'Testovacie-heslo-TV-1';
const dataDir = own ? fs.mkdtempSync(path.join(os.tmpdir(), 'adna-tv-e2e-')) : null;
let proc = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['OK  ', name]); console.log('OK   ' + name); }
  catch (e) { results.push(['FAIL', name]); console.log('FAIL ' + name + '\n     ' + (e && e.message)); throw e; }
}

async function startServer() {
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server/src/index.js')], {
    env: { ...process.env, ADNA_PORT: String(PORT), ADNA_DATA_DIR: dataDir, ADNA_QUIET: '1' }, stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error('server sa nespustil');
}
async function stopServer() { if (proc) { proc.kill('SIGTERM'); await new Promise((r) => proc.once('exit', r)); proc = null; } }

let cookie = '';
async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(d)}`);
  return d;
}
async function login() {
  if (own) {
    const code = fs.readFileSync(path.join(dataDir, 'SETUP-KOD.txt'), 'utf8').match(/KOD:\s*(\S+)/)[1];
    await api('POST', '/api/setup', { setupCode: code, password: PASSWORD });
  }
  await api('POST', '/api/auth/login', { username: 'personal', password: PASSWORD });
}
const register = () => api('POST', '/api/kiosk/tickets', { requestId: 'tv-e2e-' + Math.random().toString(36).slice(2) + Date.now(), deviceId: 'e2e' });

async function shot(page, name) {
  try { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `tv-${name}.png`) }); } catch (e) { console.log('  (snímka sa neuložila: ' + e.message + ')'); }
}

(async () => {
  if (own) await startServer();
  await login();
  const rooms = (await api('GET', '/api/staff/state')).rooms;
  await api('PUT', '/api/admin/settings', { ticketDisplaySeconds: 5 });
  const r1 = rooms[0], r2 = rooms[1] || rooms[0];

  // ---------- 1. prehliadač s povoleným automatickým prehrávaním (ako WebView v Android aplikácii) ----------
  const b1 = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await b1.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(BASE + '/obrazovka/');
  const T = () => page.evaluate(() => ({ ...window.__adnaTest }));
  const text = (sel) => page.locator(sel).innerText();
  const visible = (sel) => page.locator(sel).isVisible();

  const tile = (roomId) => page.evaluate((id) => { const t = document.querySelector(`#roomRows [data-room="${id}"] .tile`); return t ? t.textContent : null; }, roomId);
  const waitTile = (roomId, code, timeout = 15000) => page.waitForFunction(([id, c]) => { const t = document.querySelector(`#roomRows [data-room="${id}"] .tile`); return t && t.textContent === c; }, [roomId, code], { timeout });

  await step('pokoj: „Práve vyšetrujeme“ bez čísiel, keď ešte nikto nebol vyvolaný', async () => {
    await page.waitForFunction(() => window.__adnaTest.states > 0);
    assert.ok(await visible('#roomsCard'));
    assert.equal(await tile(r1.id), '–');
    assert.ok(!(await visible('#callCard')));
    assert.match(await text('#infoList'), /kartičku poistenca/);
    await sleep(800);
    assert.ok(!(await visible('#soundOverlay')), 'pri povolenom zvuku sa výzva nezobrazí');
    assert.ok(!(await visible('#soundWarn')));
    await shot(page, '1-pokoj');
  });

  const a = (await register()).ticket, b = (await register()).ticket, c = (await register()).ticket;

  await step('vyvolanie: číslo + ambulancia + banner cez TV + zvuk', async () => {
    const before = await T();
    await api('POST', `/api/staff/tickets/${a.id}/call`, { roomId: r1.id });
    await page.waitForFunction((code) => document.getElementById('callCode').textContent === code, a.code, { timeout: 5000 });
    assert.equal(await text('#callRoom'), r1.name);
    assert.ok(await visible('#tvCall'));
    assert.match(await text('#tvCallTitle'), new RegExp(`${a.code}, prosíme, vstúpte`));
    const t = await T();
    assert.equal(t.chimes, before.chimes + 1, 'zaznel signál');
    assert.equal(t.flashes, before.flashes + 1);
    assert.equal(await page.locator('#left.calling').count(), 1, 'ľavý stĺpec je v stave vyvolania');
    await shot(page, '2-vyvolanie');
  });

  await step('zopakované vyvolanie znovu zvýrazní a prehrá zvuk', async () => {
    const before = await T();
    await sleep(400);
    await api('POST', `/api/staff/tickets/${a.id}/recall`, {});
    await page.waitForFunction((n) => window.__adnaTest.chimes > n, before.chimes, { timeout: 5000 });
    assert.equal((await T()).flashes, before.flashes + 1);
  });

  await step('„Práve vyšetrujeme“: posledné číslo v každej ambulancii', async () => {
    await api('POST', `/api/staff/tickets/${b.id}/call`, { roomId: r2.id, note: 'TAJNA-POZNAMKA objednaný' });
    await page.waitForFunction((code) => document.getElementById('callCode').textContent === code, b.code, { timeout: 8000 });
    await waitTile(r1.id, a.code);
    await page.waitForSelector('#callCard.hidden', { state: 'attached', timeout: 15000 });
    await waitTile(r2.id, b.code);
    const html = await page.content();
    assert.ok(!html.includes('TAJNA-POZNAMKA'), 'poznámka personálu sa nezobrazí');
    await shot(page, '3-ambulancie');
  });

  await step('omylom vyvolané číslo po vrátení zmizne z obrazovky', async () => {
    await api('POST', `/api/staff/tickets/${c.id}/call`, { roomId: r1.id });
    await page.waitForFunction((code) => document.getElementById('callCode').textContent === code, c.code);
    await api('POST', `/api/staff/tickets/${c.id}/requeue`, {});
    await page.waitForSelector('#callCard.hidden', { state: 'attached', timeout: 5000 });
    await waitTile(r1.id, a.code, 5000);
  });

  await step('obnovenie stránky (reštart obrazovky) obnoví stav', async () => {
    await page.reload();
    await page.waitForFunction(() => window.__adnaTest.states > 0);
    assert.equal(await tile(r1.id), a.code);
    assert.equal(await tile(r2.id), b.code);
    assert.ok(!(await visible('#callCard')), 'po obnovení sa vyvolanie nezopakuje');
    assert.equal((await T()).chimes, 0, 'po obnovení sa signál neprehrá znova');
  });

  if (own) {
    await step('výpadok servera: nenápadný štítok „offline“, posledný stav ostáva', async () => {
      await page.goto(BASE + '/obrazovka/?offline=2');
      await page.waitForFunction(() => window.__adnaTest.states > 0);
      await stopServer();
      await page.waitForSelector('#offline:not(.hidden)', { timeout: 15000 });
      assert.match(await text('#offline'), /offline/i);
      assert.equal(await tile(r2.id), b.code);
      await shot(page, '4-vypadok');
    });
    await step('po obnovení servera sa štítok skryje a stav sa načíta', async () => {
      await startServer();
      cookie = ''; await api('POST', '/api/auth/login', { username: 'personal', password: PASSWORD });
      const d = (await register()).ticket;
      await page.waitForSelector('#offline.hidden', { state: 'attached', timeout: 20000 });
      const n = (await T()).chimes;
      await api('POST', `/api/staff/tickets/${d.id}/call`, { roomId: r2.id });
      await page.waitForFunction((code) => document.getElementById('callCode').textContent === code, d.code, { timeout: 5000 });
      await page.waitForFunction((x) => window.__adnaTest.chimes > x, n);
    });
  } else {
    results.push(['SKIP', 'výpadok servera (test beží proti cudziemu serveru)']);
  }
  await b1.close();

  // ---------- 2. bežný prehliadač: automatické prehrávanie zablokované ----------
  const b2 = await chromium.launch();
  const p2 = await b2.newPage({ viewport: { width: 1280, height: 720 } });
  await p2.goto(BASE + '/obrazovka/');
  await step('zablokovaný zvuk: výzva „Zapnúť zvuk“ s fokusom a upozornenie', async () => {
    await p2.waitForSelector('#soundOverlay:not(.hidden)', { timeout: 5000 });
    assert.ok(await p2.locator('#soundWarn').isVisible());
    assert.equal(await p2.evaluate(() => document.activeElement && document.activeElement.id), 'soundBtn');
    await shot(p2, '5-zvuk-zablokovany-720p');
  });
  await step('ovládač: OK (Enter) zapne zvuk, upozornenie zmizne', async () => {
    await p2.keyboard.press('Enter');
    await p2.waitForSelector('#soundOverlay.hidden', { state: 'attached', timeout: 5000 });
    await p2.waitForSelector('#soundWarn.hidden', { state: 'attached', timeout: 5000 });
    const n = await p2.evaluate(() => window.__adnaTest.chimes);
    await api('POST', '/api/staff/call-next', { roomId: r1.id });
    await p2.waitForFunction((x) => window.__adnaTest.chimes > x, n, { timeout: 5000 });
    await shot(p2, '6-720p');
  });
  await b2.close();

  // ---------- 3. vypnutý zvuk v nastaveniach ----------
  await step('zvuk vypnutý v nastaveniach: bez výzvy a bez signálu', async () => {
    await api('PUT', '/api/admin/settings', { soundEnabled: false });
    const b3 = await chromium.launch();
    const p3 = await b3.newPage({ viewport: { width: 1920, height: 1080 } });
    await p3.goto(BASE + '/obrazovka/');
    await p3.waitForFunction(() => window.__adnaTest.states > 0);
    await sleep(900);
    assert.ok(!(await p3.locator('#soundOverlay').isVisible()));
    assert.ok(!(await p3.locator('#soundWarn').isVisible()));
    await api('POST', '/api/staff/call-next', { roomId: r1.id }).catch(() => {});
    await sleep(500);
    assert.equal(await p3.evaluate(() => window.__adnaTest.chimes), 0);
    await api('PUT', '/api/admin/settings', { soundEnabled: true });
    await b3.close();
  });

  await stopServer();
  console.log(`\nVýsledok: ${results.filter((r) => r[0] === 'OK  ').length} OK, ${results.filter((r) => r[0] === 'SKIP').length} preskočené`);
  process.exit(0);
})().catch(async (e) => { console.error(e); await stopServer(); process.exit(1); });
