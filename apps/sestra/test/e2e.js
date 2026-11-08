#!/usr/bin/env node
// End-to-end test aplikácie SESTRA (Playwright + Chromium).
// Predvolene si spustí vlastný server (port ADNA_TEST_PORT, dočasný dátový adresár) aj falošnú ESC/POS tlačiareň.
// Spustenie:  node apps/sestra/test/e2e.js
// Voliteľne:  ADNA_SCREENSHOTS=/cesta/k/adresaru  (uloží snímky obrazovky)
'use strict';
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PORT = Number(process.env.ADNA_TEST_PORT || 8181);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'adna-sestra-e2e-'));
const SHOTS = process.env.ADNA_SCREENSHOTS || '';
const PASSWORD = 'Sestra-heslo-2026';

let server = null;
function startServer() {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: path.join(ROOT, 'server'), env: { ...process.env, ADNA_PORT: String(PORT), ADNA_DATA_DIR: DATA, ADNA_QUIET: '1' }, stdio: 'ignore',
  });
  return waitFor(async () => (await fetch(URL_BASE + '/api/health')).ok, 10000, 'server sa nespustil');
}
function stopServer() {
  return new Promise((r) => { if (!server) return r(); server.once('exit', r); server.kill('SIGKILL'); server = null; });
}
async function waitFor(fn, ms, msg) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('Čas vypršal: ' + msg);
}

// ---- falošná ESC/POS tlačiareň: na DLE EOT n odpovie 0x12 (bez chyby) ----
const printed = [];
let printerSrv = null;
function startPrinter(port) {
  return new Promise((resolve) => {
    printerSrv = net.createServer((sock) => {
      let all = Buffer.alloc(0);
      sock.on('data', (d) => {
        all = Buffer.concat([all, d]);
        for (let i = 0; i < d.length - 2; i++) if (d[i] === 0x10 && d[i + 1] === 0x04) sock.write(Buffer.from([0x12]));
      });
      sock.on('end', () => { if (all.includes(Buffer.from([0x1b, 0x40]))) printed.push(all.toString('latin1')); sock.end(); });
      sock.on('error', () => {});
    });
    printerSrv.listen(port, '127.0.0.1', () => resolve(printerSrv.address().port));
  });
}
const stopPrinter = () => new Promise((r) => printerSrv.close(() => r()));

const kiosk = (id) => fetch(URL_BASE + '/api/kiosk/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ requestId: id || require('node:crypto').randomUUID(), deviceId: 'test' }) }).then((r) => r.json());
const display = () => fetch(URL_BASE + '/api/display/state').then((r) => r.json());

let step = 0;
const ok = (m) => console.log(`ok ${++step} - ${m}`);

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `sestra-${name}.png`), fullPage: true });
}
const toastWith = (page, re) => page.locator('.toast', { hasText: re }).first().waitFor({ timeout: 5000 });
const row = (page, table, code) => page.locator(`#${table} tr`, { hasText: code });

(async () => {
  let browser;
  try {
    await startServer();
    const printerPort = await startPrinter(0);
    browser = await chromium.launch();
    const ctxA = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: 'sk-SK' });
    const A = await ctxA.newPage();
    const errors = [];
    A.on('pageerror', (e) => errors.push(String(e)));

    // 1. prvotné nastavenie
    await A.goto(URL_BASE + '/sestra/');
    await A.getByText('Prvotné nastavenie hesla personálu').waitFor();
    await shot(A, '1-prvotne-nastavenie');
    const code = fs.readFileSync(path.join(DATA, 'SETUP-KOD.txt'), 'utf8').match(/KOD:\s*(\S+)/)[1];
    await A.fill('#code', code); await A.fill('#p1', 'kratke'); await A.fill('#p2', 'kratke');
    await A.click('button[type=submit]');
    await A.getByText('aspoň 10 znakov').first().waitFor();
    await A.fill('#p1', PASSWORD); await A.fill('#p2', PASSWORD);
    await A.click('button[type=submit]');
    await A.locator('#conn.conn-online').waitFor();
    await A.locator('#m-doc').waitFor(); await A.click('#m-cancel'); // v2.2: výzva na lekára dňa – tu „Neskôr“
    ok('prvotné nastavenie hesla a prihlásenie (krátke heslo odmietnuté)');

    // 2. registrácie sa objavia živo
    const t1 = await kiosk(); const t2 = await kiosk(); const t3 = await kiosk();
    assert.deepEqual([t1.ticket.code, t2.ticket.code, t3.ticket.code], ['A001', 'A002', 'A003']);
    await row(A, 'tbl-waiting', 'A003').waitFor();
    assert.equal(await A.textContent('#cnt-waiting'), '3');
    await A.getByText('Tlač lístkov je vypnutá').waitFor();
    ok('nové čísla sa zobrazia živo bez obnovenia stránky (A001–A003), upozornenie na vypnutú tlač');

    // 3. vyvolať ďalšieho, zopakovať
    await A.click('#btn-next');
    await row(A, 'tbl-called', 'A001').waitFor();
    let d = await display();
    assert.equal(d.current.code, 'A001'); assert.equal(d.current.roomName, 'Ambulancia č. 1');
    await row(A, 'tbl-called', 'A001').getByRole('button', { name: 'Zopakovať' }).click();
    await waitFor(async () => (await display()).current.repeat === true, 3000, 'zopakovanie');
    await row(A, 'tbl-called', 'A001').getByText('2×').waitFor();
    ok('„Vyvolať ďalšieho“ vyvolá najdlhšie čakajúceho; zopakovanie sa prejaví na obrazovke');

    // 4. vybavený / neprítomný / vrátiť
    await row(A, 'tbl-called', 'A001').getByRole('button', { name: 'Vybavený' }).click();
    await row(A, 'tbl-finished', 'A001').getByText('Vybavený').waitFor();
    await A.selectOption('#room', { label: 'Ambulancia č. 2' });
    await row(A, 'tbl-waiting', 'A002').getByRole('button', { name: 'Vyvolať' }).click();
    await row(A, 'tbl-called', 'A002').getByText('Ambulancia č. 2').waitFor();
    await row(A, 'tbl-called', 'A002').getByRole('button', { name: 'Neprítomný' }).click();
    await row(A, 'tbl-finished', 'A002').getByText('Neprítomný').waitFor();
    await row(A, 'tbl-finished', 'A002').getByRole('button', { name: 'Vrátiť', exact: true }).click();
    await A.click('#m-ok');
    await row(A, 'tbl-waiting', 'A002').waitFor();
    ok('stavy Vybavený, Neprítomný a vrátenie medzi čakajúcich (s potvrdením); výber ambulancie');

    // 5. konflikt dvoch sestier
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'sk-SK' });
    const B = await ctxB.newPage();
    await B.goto(URL_BASE + '/sestra/');
    await B.fill('#pw', 'zle-heslo-123'); await B.click('#login-btn');
    await B.getByText('Nesprávne meno alebo heslo').waitFor();
    await B.fill('#pw', PASSWORD); await B.click('#login-btn');
    await B.locator('#m-doc').waitFor(); await B.click('#m-cancel'); // v2.2: výzva na lekára dňa – tu „Neskôr“
    await row(B, 'tbl-waiting', 'A003').waitFor();
    await row(B, 'tbl-waiting', 'A003').getByRole('button', { name: /Vyvolať/ }).click(); // mimo poradia → okno
    await B.locator('#m-note').waitFor();
    await B.fill('#m-note', 'objednaný na 9:30');
    // medzitým sestra A vyvolá to isté číslo
    await row(A, 'tbl-waiting', 'A003').getByRole('button', { name: /Vyvolať/ }).click();
    await A.click('#m-ok');
    await row(A, 'tbl-called', 'A003').waitFor();
    await B.click('#m-ok');
    await toastWith(B, /už medzičasom vyvolala iná sestra/);
    await shot(B, '3-konflikt');
    d = await display();
    assert.equal(d.current.code, 'A003'); assert.equal(d.current.roomName, 'Ambulancia č. 2', 'platí vyvolanie sestry A');
    ok('dve sestry vyvolajú to isté číslo → druhá dostane zrozumiteľné upozornenie, platí len prvé vyvolanie');

    // 6. obnovenie stránky
    await A.reload();
    await A.locator('#m-doc').waitFor(); await A.click('#m-cancel'); // po obnovení sa výzva na lekára zopakuje
    await row(A, 'tbl-called', 'A003').waitFor();
    await row(A, 'tbl-waiting', 'A002').waitFor();
    ok('obnovenie stránky (F5) načíta úplný stav zo servera, prihlásenie ostáva');

    // 7. reštart servera
    await stopServer();
    await A.locator('#conn.conn-offline, #conn.conn-connecting').first().waitFor({ timeout: 10000 });
    await A.getByText('Bez spojenia so serverom').waitFor({ timeout: 10000 });
    assert.equal(await A.locator('#btn-next').isDisabled(), true, 'akcie sú počas výpadku vypnuté');
    await shot(A, '4-vypadok');
    await startServer();
    await A.locator('#conn.conn-online').waitFor({ timeout: 20000 });
    await row(A, 'tbl-called', 'A003').waitFor();
    await row(B, 'tbl-called', 'A003').waitFor();
    const t4 = await kiosk();
    assert.equal(t4.ticket.code, 'A004', 'číslovanie pokračuje po reštarte');
    await row(A, 'tbl-waiting', 'A004').waitFor();
    ok('reštart servera: UI ukáže výpadok, vypne akcie, samo sa znovu pripojí a obnoví stav; čísla pokračujú A004');

    // 8. nastavenia
    await A.click('.tab[data-view=admin]');
    await A.locator('#f-general').waitFor();
    await A.fill('#s-secs', '20');
    await A.locator('#f-general button[type=submit]').click();
    await toastWith(A, /Nastavenia boli uložené/);
    assert.equal((await (await fetch(URL_BASE + '/api/public/config')).json()).ticketDisplaySeconds, 20);
    await A.fill('#new-room', 'Odberová miestnosť'); await A.click('#f-room button[type=submit]');
    await A.locator('#tbl-rooms input.r-name[value="Odberová miestnosť"]').waitFor();
    await A.check('#p-enabled'); await A.fill('#p-host', '127.0.0.1'); await A.fill('#p-port', String(printerPort));
    await A.locator('#f-printer button[type=submit]').click();
    await toastWith(A, /tlačiarne boli uložené/);
    await A.click('#p-check');
    await toastWith(A, /Tlačiareň je pripravená/);
    await shot(A, '5-nastavenia');
    ok('nastavenia: čas zobrazenia, nová ambulancia, tlačiareň + overenie stavu tlačiarne');

    // 9. opakovaná tlač bez nového čísla
    await A.click('.tab[data-view=queue]');
    const countBefore = (await (await fetch(URL_BASE + '/api/display/state')).json()) && printed.length;
    await row(A, 'tbl-waiting', 'A002').getByRole('button', { name: 'Tlač' }).click();
    await A.click('#m-ok');
    await toastWith(A, /A002: Lístok bol vytlačený/);
    assert.equal(printed.length, countBefore + 1);
    assert.ok(printed[printed.length - 1].includes('A002') && printed[printed.length - 1].includes('opakovana tlac'));
    const t5 = await kiosk();
    assert.equal(t5.ticket.code, 'A005', 'opakovaná tlač nevytvorila nové číslo');
    assert.equal(t5.print.status, 'ok');
    ok('„Znovu vytlačiť lístok“ vytlačí rovnaké číslo A002 (overené na falošnej tlačiarni), nové číslo nevzniklo');

    // 10. zlyhanie tlače → upozornenie → opakovaná tlač
    await stopPrinter();
    const t6 = await kiosk();
    assert.equal(t6.print.status, 'failed');
    const alert = A.locator(`[data-print-alert="${t6.ticket.id}"]`);
    await alert.getByText('Tlač zlyhala').waitFor();
    await shot(A, '2-zoznam');
    await startPrinter(printerPort);
    await alert.getByRole('button', { name: 'Znovu vytlačiť lístok' }).click();
    await A.click('#m-ok');
    await alert.waitFor({ state: 'detached' });
    ok('nedostupná tlačiareň → upozornenie pre personál; po opätovnej tlači upozornenie zmizne');

    // 11. história
    await A.click('.tab[data-view=history]');
    await A.locator('#hist-detail table').waitFor();
    await A.locator('#hist-detail').getByText('objednaný na 9:30').count().then((n) => assert.equal(n, 0, 'poznámka z neúspešného vyvolania sa neuložila'));
    await A.locator('#hist-detail').getByText('Opakovaná tlač').first().waitFor();
    ok('história dňa so stavmi a priebehom');

    // 12. ukončenie dňa s potvrdením
    await A.click('.tab[data-view=admin]');
    await A.click('#btn-close-day');
    await A.fill('#m-confirm', 'nie'); await A.click('#m-ok');
    await A.locator('#m-err', { hasText: 'UKONČIŤ' }).waitFor();
    await A.fill('#m-confirm', 'UKONČIŤ'); await A.click('#m-ok');
    await toastWith(A, /Deň bol ukončený/);
    assert.equal((await display()).current, null);
    ok('ukončenie dňa vyžaduje napísanie UKONČIŤ; obrazovka sa vyčistí');

    // 13. odhlásenie
    await A.click('#btn-logout'); await A.click('#m-ok');
    await A.locator('#pw').waitFor();
    ok('odhlásenie');

    assert.deepEqual(errors, [], 'bez chýb JavaScriptu na stránke');
    ok('bez chýb JavaScriptu');
    console.log(`\n# pass ${step}\n# fail 0`);
  } catch (e) {
    console.error('not ok - ' + (e.stack || e));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    await stopServer();
    try { printerSrv && printerSrv.close(); } catch {}
  }
})();
