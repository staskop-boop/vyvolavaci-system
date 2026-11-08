'use strict';
// Integračný test celého toku: tablet → tlač lístka → zoznam sestry → vyvolanie → obrazovka TV so zvukom.
// Spúšťa vlastný server (dočasná DB) a simulovanú sieťovú ESC/POS tlačiareň. Spustenie: node tests/integracia.js
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');
const { fakePrinter } = require('../server/test/fake-printer');

const PORT = Number(process.env.ADNA_TEST_PORT || 8190);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'adna-integ-'));
const PW = 'Integracne-heslo-2026';
let proc;
const results = [];

function startServer() {
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'src', 'index.js')], {
    env: { ...process.env, ADNA_PORT: String(PORT), ADNA_HOST: '127.0.0.1', ADNA_DATA_DIR: DATA, ADNA_QUIET: '1' }, stdio: 'ignore',
  });
  return (async () => {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    throw new Error('server sa nespustil');
  })();
}
async function killServer() { proc.kill('SIGKILL'); await new Promise((r) => proc.once('exit', r)); }

async function api(method, p, body, cookie) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
async function step(name, fn) {
  try { await fn(); results.push(['OK', name]); console.log('  OK  ', name); }
  catch (e) { results.push(['CHYBA', name]); console.log('  CHYBA', name, '\n       ', e.message.split('\n')[0]); throw e; }
}

(async () => {
  const printer = await fakePrinter('ok');
  await startServer();
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  let exitCode = 0;
  try {
    const code = fs.readFileSync(path.join(DATA, 'SETUP-KOD.txt'), 'utf8').match(/KOD:\s*(\S+)/)[1];
    await api('POST', '/api/setup', { setupCode: code, password: PW });
    const admin = (await api('POST', '/api/auth/login', { password: PW })).cookie;
    await api('PUT', '/api/admin/settings', { ticketDisplaySeconds: 5, printer: { enabled: true, host: '127.0.0.1', port: printer.port, statusTimeoutMs: 500 } }, admin);

    const tabletCtx = await browser.newContext({ ...devices['Galaxy Tab S4'] });
    const tablet = await tabletCtx.newPage();
    const nurseCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const nurse = await nurseCtx.newPage();
    const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const tv = await tvCtx.newPage();
    const errors = [];
    for (const [n, p] of [['tablet', tablet], ['sestra', nurse], ['tv', tv]]) p.on('pageerror', (e) => errors.push(n + ': ' + e.message));

    await tablet.goto(BASE + '/tablet/');
    await tv.goto(BASE + '/obrazovka/?offline=2');
    await nurse.goto(BASE + '/sestra/');
    await nurse.fill('#pw', PW);
    await nurse.click('#login-btn');
    await nurse.waitForSelector('#btn-next');
    await nurse.locator('#m-doc').waitFor(); await nurse.click('#m-cancel'); // v2.2: výzva na lekára dňa – tu „Neskôr“

    await step('TV v pokoji zobrazuje „Práve vyšetrujeme“ bez výzvy', async () => {
      await tv.waitForSelector('#roomsCard:not(.hidden)');
      await tv.waitForSelector('#callCard.hidden', { state: 'attached' });
    });

    await step('Tablet: pacient stlačí „Prihlásiť sa“ → číslo A001 na tablete', async () => {
      await tablet.tap('#btn-register');
      await tablet.waitForFunction(() => document.querySelector('#ticket-code').textContent.trim() === 'A001' && !document.querySelector('#screen-result').hidden);
    });

    await step('Tlač: lístok A001 dorazil na sieťovú ESC/POS tlačiareň (číslo, AdNa, dátum, pokyn)', async () => {
      const job = printer.state.jobs.at(-1).toString('latin1');
      assert.ok(job.includes('A001') && job.includes('AdNa') && job.includes('sledujte obrazovku'));
      assert.match(job, /\d{1,2}\. ?\d{1,2}\. ?\d{4}/);
      await tablet.waitForFunction(() => /tlačí|vezmite/i.test(document.querySelector('#print-status').textContent));
    });

    await step('Sestra: A001 sa bez obnovenia stránky objaví v zozname čakajúcich', async () => {
      await nurse.waitForFunction(() => document.body.innerText.includes('A001'));
    });

    await step('Sestra: výber „Ambulancia č. 2“ a „Vyvolať ďalšieho“', async () => {
      const opt = await nurse.$$eval('#room option', (os) => os.map((o) => [o.value, o.textContent]));
      await nurse.selectOption('#room', opt.find((o) => o[1].includes('č. 2'))[0]);
      await nurse.waitForSelector('#btn-next:not([disabled])');
      await nurse.click('#btn-next');
    });

    await step('TV: veľké číslo A001, „Ambulancia č. 2“ a zvukový signál', async () => {
      await tv.waitForFunction(() => document.querySelector('#callCode').textContent.trim() === 'A001'
        && document.querySelector('#callRoom').textContent.includes('Ambulancia č. 2'));
      await tv.waitForFunction(() => window.__adnaTest.chimes >= 1);
    });

    await step('Sestra: „Zopakovať“ → TV znovu zvýrazní a prehrá zvuk', async () => {
      const before = await tv.evaluate(() => window.__adnaTest.chimes);
      await nurse.click('button[data-act="recall"]');
      await tv.waitForFunction((b) => window.__adnaTest.chimes > b, before);
    });

    await step('Tablet sa po nastavenom čase sám vráti na úvodnú obrazovku', async () => {
      await tablet.waitForSelector('#screen-start:not([hidden])', { timeout: 9000 });
    });

    await step('Dva tablety stlačia naraz → dve rôzne čísla A002 a A003', async () => {
      const t2ctx = await browser.newContext({ ...devices['Galaxy Tab S4'] });
      const t2 = await t2ctx.newPage();
      await t2.goto(BASE + '/tablet/');
      await Promise.all([tablet.tap('#btn-register'), t2.tap('#btn-register')]);
      const codes = await Promise.all([tablet, t2].map(async (p) => {
        await p.waitForSelector('#screen-result:not([hidden])');
        return (await p.textContent('#ticket-code')).trim();
      }));
      assert.deepEqual(codes.sort(), ['A002', 'A003']);
      await t2ctx.close();
    });

    await step('Sestra: opakovaná tlač A002 → nový lístok na tlačiarni, žiadne nové číslo', async () => {
      const st = (await api('GET', '/api/staff/state', null, admin)).data;
      const t = st.tickets.find((x) => x.code === 'A002');
      const jobs = printer.state.jobs.length;
      await nurse.waitForSelector(`button[data-act="reprint"][data-id="${t.id}"]`);
      await nurse.click(`button[data-act="reprint"][data-id="${t.id}"]`);
      const confirm = await nurse.$('.modal button.btn-primary, dialog button.btn-primary');
      if (confirm) await confirm.click();
      for (let i = 0; i < 50 && printer.state.jobs.length === jobs; i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(printer.state.jobs.length, jobs + 1);
      assert.ok(printer.state.jobs.at(-1).toString('latin1').includes('A002'));
      assert.equal((await api('GET', '/api/staff/state', null, admin)).data.tickets.length, st.tickets.length);
    });

    await step('Výpadok servera: TV aj sestra ukážu stratu spojenia, TV ponechá posledné číslo', async () => {
      await killServer();
      await tv.waitForSelector('#offline:not(.hidden)', { timeout: 15000 });
      assert.ok((await tv.textContent('#roomRows')).includes('A001'), 'posledné číslo ostáva v ambulancii');
      await nurse.waitForSelector('#btn-next[disabled]', { timeout: 15000 });
    });

    await step('Obnova servera: všetky tri zariadenia sa samy pripoja a stav je zachovaný', async () => {
      await startServer();
      const w = (p, sel, label) => p.waitForSelector(sel, { timeout: 20000, state: 'attached' }).catch((e) => { throw new Error(label + ': ' + e.message); });
      await w(tv, '#offline.hidden', 'TV').catch(async (e) => { console.log(await tv.evaluate(() => [document.querySelector('#offline').className, JSON.stringify(window.__adnaTest)])); throw e; });
      await w(nurse, '#btn-next:not([disabled])', 'sestra');
      await w(tablet, '#offline[hidden]', 'tablet');
      await tablet.waitForSelector('#screen-start:not([hidden])', { timeout: 9000 });
      await tablet.tap('#btn-register');
      await tablet.waitForFunction(() => document.querySelector('#ticket-code').textContent.trim() === 'A004');
      await nurse.waitForFunction(() => document.body.innerText.includes('A004'));
    });

    await step('Bez chýb JavaScriptu na všetkých troch zariadeniach', async () => { assert.deepEqual(errors, []); });

    await tablet.screenshot({ path: '/mnt/project-files/adna/screenshots/integracia-tablet.png' }).catch(() => {});
    await nurse.screenshot({ path: '/mnt/project-files/adna/screenshots/integracia-sestra.png' }).catch(() => {});
    await tv.screenshot({ path: '/mnt/project-files/adna/screenshots/integracia-tv.png' }).catch(() => {});
  } catch (e) {
    exitCode = 1;
  } finally {
    await browser.close();
    try { proc.kill('SIGKILL'); } catch {}
    await printer.close();
    const ok = results.filter((r) => r[0] === 'OK').length;
    console.log(`\nIntegračný test: ${ok}/${results.length} krokov v poriadku${exitCode ? ' – ZLYHAL' : ''}`);
    process.exit(exitCode);
  }
})();
