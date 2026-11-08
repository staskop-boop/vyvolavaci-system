'use strict';
// E2E test tabletovej aplikácie (webová časť) + tlač na simulovanú ESC/POS tlačiareň.
// Spustenie:  ADNA_URL=http://127.0.0.1:8182 ADNA_PASSWORD=... [ADNA_SETUP_CODE=...] node apps/tablet/test/e2e.js
// Tlačiareň je simulovaná TCP serverom na 127.0.0.1 – server AdNa musí bežať na tom istom počítači.
const net = require('node:net');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');

const BASE = process.env.ADNA_URL || 'http://127.0.0.1:8182';
const PASSWORD = process.env.ADNA_PASSWORD || 'Tablet-test-heslo-1';
const SHOTS = process.env.ADNA_SHOTS || '/mnt/project-files/adna/screenshots/';

// ---------- simulovaná tlačiareň ----------
function fakePrinter() {
  const p = { mode: 'ok', jobs: [] };
  p.server = net.createServer((sock) => {
    const chunks = [];
    sock.on('data', (d) => {
      chunks.push(d);
      if (p.mode === 'silent') return;
      // odpoveď na DLE EOT n (0x10 0x04 n): 1 bajt za každý dotaz
      for (let i = 0; i + 2 < d.length; i++) {
        if (d[i] === 0x10 && d[i + 1] === 0x04) {
          const n = d[i + 2];
          sock.write(Buffer.from([n === 4 && p.mode === 'paper' ? 0x72 : 0x12]));
          i += 2;
        }
      }
    });
    sock.on('end', () => { p.jobs.push(Buffer.concat(chunks)); sock.end(); });
    sock.on('error', () => {});
  });
  return new Promise((r) => p.server.listen(0, '127.0.0.1', () => { p.port = p.server.address().port; r(p); }));
}
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => r(port)); }); });

// ---------- API personálu ----------
let cookie = '';
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}
async function login() {
  const st = await api('GET', '/api/setup/status');
  if (st.setupRequired) await api('POST', '/api/setup', { setupCode: process.env.ADNA_SETUP_CODE, password: PASSWORD });
  await api('POST', '/api/auth/login', { username: 'personal', password: PASSWORD });
}
const tickets = async () => (await api('GET', '/api/staff/state')).tickets;

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push(['OK  ', name, Date.now() - t0]); console.log('OK   ' + name); }
  catch (e) { results.push(['FAIL', name, Date.now() - t0]); console.log('FAIL ' + name + '\n     ' + (e.stack || e).split('\n').slice(0, 3).join('\n     ')); process.exitCode = 1; }
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await login();
  const printer = await fakePrinter();
  await api('PUT', '/api/admin/settings', { ticketDisplaySeconds: 6, printer: { enabled: false } });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Galaxy Tab S4'], locale: 'sk-SK', timezoneId: 'Europe/Bratislava' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const shot = (n) => page.screenshot({ path: SHOTS + 'tablet-' + n + '.png' });
  const tapRegister = () => page.locator('#btn-register').tap();

  await step('úvodná obrazovka: AdNa + „Prihlásiť sa“', async () => {
    await page.goto(BASE + '/tablet/');
    await page.locator('#screen-start').waitFor({ state: 'visible' });
    assert.equal((await page.locator('#btn-register').innerText()).trim(), 'Prihlásiť sa');
    assert.match(await page.locator('.brand').innerText(), /AdNa/);
    await shot('1-uvod');
  });

  await step('registrácia → veľké číslo, pokyn, „Hotovo“ vráti na začiatok', async () => {
    const before = (await tickets()).length;
    await tapRegister();
    await page.locator('#screen-result').waitFor({ state: 'visible' });
    const code = await page.locator('#ticket-code').innerText();
    assert.match(code, /^A\d{3}$/);
    assert.match(await page.locator('#instruction').innerText(), /Posaďte sa, prosím, a sledujte obrazovku v čakárni/);
    const all = await tickets();
    assert.equal(all.length, before + 1);
    assert.equal(all[all.length - 1].code, code);
    await page.locator('#btn-done').tap();
    await page.locator('#screen-start').waitFor({ state: 'visible' });
  });

  await step('rýchle trojité ťuknutie = presne jedno nové číslo', async () => {
    await page.waitForTimeout(900); // ochranná pauza po návrate
    const before = (await tickets()).length;
    const box = await page.locator('#btn-register').boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await Promise.all([page.touchscreen.tap(x, y), page.touchscreen.tap(x, y), page.touchscreen.tap(x, y)]);
    await page.mouse.click(x, y); await page.mouse.click(x, y);
    await page.locator('#screen-result').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
    assert.equal((await tickets()).length, before + 1);
  });

  await step('automatický návrat na úvodnú obrazovku po nastavenom čase (6 s)', async () => {
    const t0 = Date.now();
    await page.locator('#screen-start').waitFor({ state: 'visible', timeout: 10000 });
    const dt = Date.now() - t0;
    assert.ok(dt > 3000, 'návrat príliš skoro: ' + dt);
  });

  await step('výpadok spojenia po spracovaní na serveri → opakovanie dá TO ISTÉ číslo', async () => {
    await page.waitForTimeout(900);
    const before = (await tickets()).length;
    let first = null, calls = 0;
    await page.route('**/api/kiosk/tickets', async (route) => {
      calls++;
      if (calls === 1) {
        const resp = await route.fetch();          // server požiadavku spracuje…
        first = await resp.json();
        await route.abort('connectionreset');      // …ale odpoveď sa k tabletu nedostane
      } else route.continue();
    });
    await tapRegister();
    await page.locator('#screen-result').waitFor({ state: 'visible', timeout: 15000 });
    await page.unroute('**/api/kiosk/tickets');
    const code = await page.locator('#ticket-code').innerText();
    assert.equal(code, first.ticket.code);
    assert.ok(calls >= 2);
    assert.equal((await tickets()).length, before + 1);
    await page.locator('#btn-done').tap();
  });

  await step('server nedostupný → zrozumiteľná chyba; obnovenie stránky dokončí tú istú požiadavku', async () => {
    await page.waitForTimeout(900);
    const before = (await tickets()).length;
    const seen = [];
    await page.route('**/api/kiosk/tickets', (route) => { seen.push(route.request().postDataJSON().requestId); route.abort('connectionrefused'); });
    await tapRegister();
    await page.locator('#screen-error').waitFor({ state: 'visible', timeout: 20000 });
    assert.match(await page.locator('#error-text').innerText(), /Nepodarilo sa spojiť so serverom/);
    await shot('5-chyba-spojenia');
    assert.ok(seen.length >= 3 && new Set(seen).size === 1, 'všetky pokusy s rovnakým requestId');
    await page.locator('#btn-retry').tap();
    await page.waitForTimeout(300);
    await page.unroute('**/api/kiosk/tickets');
    await page.reload(); // napr. reštart WebView počas výpadku
    await page.locator('#screen-result').waitFor({ state: 'visible', timeout: 15000 });
    assert.equal((await tickets()).length, before + 1);
    const pend = await page.evaluate(() => sessionStorage.getItem('adna.tablet.pending'));
    assert.equal(pend, null);
    await page.locator('#btn-done').tap();
  });

  await step('„Zrušiť“ po chybe vráti úvod a ďalšie stlačenie má nový requestId', async () => {
    await page.waitForTimeout(900);
    const ids = [];
    await page.route('**/api/kiosk/tickets', (route) => { ids.push(route.request().postDataJSON().requestId); route.abort('connectionrefused'); });
    await tapRegister();
    await page.locator('#screen-error').waitFor({ state: 'visible', timeout: 20000 });
    await page.locator('#btn-cancel').tap();
    await page.locator('#screen-start').waitFor({ state: 'visible' });
    await page.unroute('**/api/kiosk/tickets');
    await page.waitForTimeout(900);
    let id2 = null;
    await page.route('**/api/kiosk/tickets', (route) => { id2 = route.request().postDataJSON().requestId; route.continue(); });
    await tapRegister();
    await page.locator('#screen-result').waitFor({ state: 'visible' });
    await page.unroute('**/api/kiosk/tickets');
    assert.notEqual(id2, ids[0]);
    await page.locator('#btn-done').tap();
  });

  async function printCase(name, cfg, mode, cls, re, shotName) {
    await step(name, async () => {
      printer.mode = mode;
      await api('PUT', '/api/admin/settings', { printer: { enabled: true, host: '127.0.0.1', statusTimeoutMs: 800, connectTimeoutMs: 1500, ...cfg } });
      await page.waitForTimeout(900);
      const jobs = printer.jobs.length;
      await tapRegister();
      await page.locator('#screen-result').waitFor({ state: 'visible', timeout: 15000 });
      const code = await page.locator('#ticket-code').innerText();
      assert.equal(await page.locator('#print-status').getAttribute('class'), 'print-status ' + cls);
      assert.match(await page.locator('#print-status').innerText(), re);
      const t = (await tickets()).find((x) => x.code === code);
      if (shotName) await shot(shotName);
      if (mode === 'ok' || mode === 'silent') {
        await new Promise((r) => setTimeout(r, 300));
        const job = printer.jobs.slice(jobs).map(String).join('');
        assert.ok(job.includes(code), 'lístok obsahuje číslo');
        assert.ok(job.includes('AdNa') && job.includes('Posadte sa'), 'lístok obsahuje názov a pokyn');
      }
      await page.locator('#btn-done').tap();
    });
  }
  await printCase('tlač OK (tlačiareň hlási stav bez chyby)', { port: printer.port }, 'ok', 'ok', /Lístok sa tlačí, vezmite si ho/, '2-cislo-tlac-ok');
  await printCase('chýba papier → tlač zlyhala, číslo ostáva', { port: printer.port }, 'paper', 'failed', /nepodarilo vytlačiť.*Sestra je informovaná/, '3-cislo-tlac-zlyhala');
  await printCase('tlačiareň neodpovedá na stav → neoverená tlač (netvrdí, že sa vytlačilo)', { port: printer.port }, 'silent', 'unverified', /Ak sa lístok nevytlačil/, '4-cislo-tlac-neoverena');
  await printCase('tlačiareň nedostupná (zatvorený port) → zlyhala', { port: await freePort() }, 'closed', 'failed', /nepodarilo vytlačiť/, null);

  await step('personál znovu vytlačí existujúci lístok bez vytvorenia nového čísla', async () => {
    await api('PUT', '/api/admin/settings', { printer: { enabled: true, host: '127.0.0.1', port: printer.port } });
    printer.mode = 'ok';
    const all = await tickets();
    const failed = all.filter((t) => t.print.status === 'failed').pop();
    assert.ok(failed, 'existuje lístok so zlyhanou tlačou');
    const jobs = printer.jobs.length;
    const r = await api('POST', `/api/staff/tickets/${failed.id}/reprint`, {});
    assert.equal(r.print.status, 'ok');
    await new Promise((res) => setTimeout(res, 300));
    assert.equal((await tickets()).length, all.length);
    const job = printer.jobs.slice(jobs).map(String).join('');
    assert.ok(job.includes(failed.code) && job.includes('opakovana tlac'));
  });

  await step('nenápadné upozornenie pri strate spojenia so serverom', async () => {
    const p2 = await ctx.newPage();
    await p2.routeWebSocket(/\/ws/, (ws) => ws.close());
    await p2.goto(BASE + '/tablet/');
    await p2.locator('#offline').waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await p2.locator('#offline').innerText(), /Bez spojenia/);
    await p2.screenshot({ path: SHOTS + 'tablet-6-bez-spojenia.png' });
    await p2.close();
  });

  await step('žiadne chyby JavaScriptu na stránke', async () => { assert.deepEqual(errors, []); });

  await api('PUT', '/api/admin/settings', { ticketDisplaySeconds: 15, printer: { enabled: false } });
  await browser.close();
  printer.server.close();
  console.log(`\n${results.filter((r) => r[0] === 'OK  ').length}/${results.length} krokov prešlo`);
})().catch((e) => { console.error(e); process.exit(1); });
