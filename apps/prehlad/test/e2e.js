#!/usr/bin/env node
// End-to-end test aplikácie PREHĽAD (mobil, Playwright + Chromium).
// Spustí vlastný server s dočasnými údajmi, pripraví pacientov a overí prihlásenie, živý stav, štatistiky a ochranu údajov.
// Spustenie:  node apps/prehlad/test/e2e.js      Voliteľne: ADNA_SCREENSHOTS=/cesta (snímky obrazovky)
'use strict';
const { chromium, devices } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PORT = Number(process.env.ADNA_TEST_PORT || 8183);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'adna-prehlad-e2e-'));
const SHOTS = process.env.ADNA_SCREENSHOTS || '';
const PASSWORD = 'Prehlad-heslo-2026';

let server = null;
async function waitFor(fn, ms, msg) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('Čas vypršal: ' + msg);
}
function startServer() {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: path.join(ROOT, 'server'), env: { ...process.env, ADNA_PORT: String(PORT), ADNA_DATA_DIR: DATA, ADNA_QUIET: '1' }, stdio: 'ignore',
  });
  return waitFor(async () => (await fetch(URL_BASE + '/api/health')).ok, 10000, 'server sa nespustil');
}

// jednoduchý klient API s cookie
function client() {
  let cookie = '';
  return async (p, body, method) => {
    const r = await fetch(URL_BASE + p, { method: method || (body !== undefined ? 'POST' : 'GET'),
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${p}: ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
}
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name), fullPage: true }); } };

let passed = 0;
async function step(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

(async () => {
  await startServer();
  const code = fs.readFileSync(path.join(DATA, 'SETUP-KOD.txt'), 'utf8').match(/KOD:\s*(\S+)/)[1];
  const admin = client();
  await admin('/api/setup', { setupCode: code, password: PASSWORD });
  await admin('/api/auth/login', { username: 'admin', password: PASSWORD });
  await admin('/api/admin/users', { username: 'kovac', password: 'Lekar-heslo-2026', role: 'staff', doctorName: 'MUDr. Kováč' });
  const st = await admin('/api/staff/state');
  const r1 = st.rooms[0].id;
  await admin(`/api/staff/rooms/${r1}/doctor`, { name: 'MUDr. Kováč' });
  await admin(`/api/staff/rooms/${r1}/nurse`, { name: 'Bc. Nováková' });
  const hhmm = (min) => new Intl.DateTimeFormat('sk-SK', { timeZone: 'Europe/Bratislava', hour: '2-digit', minute: '2-digit' }).format(new Date(Date.now() + min * 60000));
  const a = await admin('/api/staff/cards', { cardNo: 'K1', plannedTime: hhmm(-20), roomId: r1, staffNote: 'Tajný Identifikátor', patientType: 'Kontrola varixy' });
  await admin('/api/staff/cards', { cardNo: 'K2', plannedTime: hhmm(10), roomId: r1 });
  await admin('/api/kiosk/tickets', { requestId: crypto.randomUUID(), deviceId: 'test' });
  const k1 = a.ticket ? a.ticket.id : a.id;
  await admin(`/api/staff/tickets/${k1}/call`, { roomId: r1 });
  await admin(`/api/staff/tickets/${k1}/to-doctor`, { direct: true });   // K1 je u lekára
  await admin('/api/staff/cards', { cardNo: 'K3', plannedTime: hhmm(-5), roomId: r1 });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  try {
    await step('Bez prihlásenia sa ukáže prihlasovací formulár', async () => {
      await page.goto(URL_BASE + '/prehlad/');
      await page.waitForSelector('#login-form');
      await shot(page, 'prehlad-1-prihlasenie.png');
    });
    await step('Zlé heslo ukáže chybu s ⚠ a textom', async () => {
      await page.fill('#un', 'admin'); await page.fill('#pw', 'zle-heslo-123');
      await page.click('#btn-login');
      await page.waitForSelector('#login-err .err');
      assert.match(await page.textContent('#login-err'), /⚠/);
    });
    await step('Správca sa prihlási a vidí živý stav', async () => {
      await page.fill('#pw', PASSWORD); await page.click('#btn-login');
      await page.waitForSelector('text=Práve teraz');
      await page.waitForSelector('#conn.conn-online');
      const t = await page.textContent('main');
      assert.match(t, /Ambulancie/);
      assert.match(t, /MUDr\. Kováč/);
      assert.match(t, /Bc\. Nováková/);
      assert.match(t, /K1\s*u lekára/);
      assert.match(t, /Čakáreň/);
      assert.match(t, /K2/);
    });
    await step('Identifikátor pacienta sa na diaľku nezobrazuje', async () => {
      assert.ok(!(await page.textContent('body')).includes('Tajný Identifikátor'));
    });
    await step('Dnešné štatistiky a týždeň pre správcu', async () => {
      await page.waitForSelector('text=Dnes spolu');
      await page.waitForSelector('text=Tento týždeň podľa lekárov');
      await page.waitForSelector('a[href="/sestra/"]');
      await shot(page, 'prehlad-2-stav.png');
    });
    await step('Zmena v ambulancii sa prejaví sama (bez obnovenia)', async () => {
      const s = await admin('/api/staff/state');
      const k2 = s.tickets.find((t) => t.code === 'K2');
      await admin(`/api/staff/tickets/${k2.id}/call`, { roomId: s.rooms[1].id });
      await page.waitForFunction(() => /K2\s*u sestry/.test(document.querySelector('main').innerText), null, { timeout: 5000 });
    });
    await step('Pri výpadku servera upozornenie s ⚠', async () => {
      await new Promise((r) => { server.once('exit', r); server.kill('SIGKILL'); });
      await page.waitForSelector('.banner.warn', { timeout: 20000 });
      assert.match(await page.textContent('#conn'), /⚠/);
      await shot(page, 'prehlad-3-vypadok.png');
      await startServer();
      await page.waitForSelector('#conn.conn-online', { timeout: 20000 });
    });
    await step('Odhlásenie vráti na prihlásenie', async () => {
      await page.click('#btn-logout');
      await page.waitForSelector('#login-form');
    });
    await step('Lekár vidí živý stav, nie štatistiky správcu', async () => {
      await page.fill('#un', 'kovac'); await page.fill('#pw', 'Lekar-heslo-2026'); await page.click('#btn-login');
      await page.waitForSelector('text=Práve teraz');
      await page.waitForTimeout(800);
      const t = await page.textContent('main');
      assert.ok(!/Dnes spolu/.test(t) && !/Tento týždeň/.test(t));
      assert.equal(await page.textContent('#brand-sub'), 'MUDr. Kováč');
    });
    await step('Bez JavaScriptových chýb', async () => { assert.deepEqual(errors, []); });
    console.log(`\nPrehľad e2e: ${passed} testov prešlo.`);
  } finally {
    await browser.close();
    if (server) server.kill('SIGKILL');
  }
})().catch((e) => { console.error('✗', e); if (server) server.kill('SIGKILL'); process.exit(1); });
