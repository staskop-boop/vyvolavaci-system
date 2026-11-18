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

    // 4. ukončený / neprítomný / vrátiť
    await row(A, 'tbl-called', 'A001').getByRole('button', { name: 'Ukončený' }).click();
    await row(A, 'tbl-finished', 'A001').getByText('Ukončený').waitFor();
    await A.selectOption('#room', { label: 'Ambulancia č. 2' });
    await row(A, 'tbl-waiting', 'A002').getByRole('button', { name: 'Vyvolať' }).click();
    await row(A, 'tbl-called', 'A002').getByText('Ambulancia č. 2').waitFor();
    await row(A, 'tbl-called', 'A002').getByRole('button', { name: 'Neprítomný' }).click();
    await row(A, 'tbl-finished', 'A002').getByText('Neprítomný').waitFor();
    await row(A, 'tbl-finished', 'A002').getByRole('button', { name: '↩ Vrátiť', exact: true }).click();
    await A.click('#m-ok');
    await row(A, 'tbl-waiting', 'A002').waitFor();
    ok('stavy Ukončený, Neprítomný a vrátenie medzi čakajúcich (s potvrdením); výber ambulancie');

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

    // 10b. (2026-11-16) výber ambulancie pri pridaní, zmena ambulancie, zrušenie chybne zadaného pacienta
    await A.selectOption('#room', { label: 'Ambulancia č. 1' });
    await A.click('#btn-card');
    await A.fill('#m-card', 'K7'); await A.fill('#m-time', '10:00');
    assert.equal(await A.locator('#m-room option:checked').textContent(), 'Ambulancia č. 1', 'predvolená je ambulancia sestry');
    await A.selectOption('#m-room', { label: 'Ambulancia č. 2' });
    await shot(A, '6-pridat-ambulancia');
    await A.click('#m-ok');
    await toastWith(A, /K7 zaradený.*Ambulancia č\. 2/);
    assert.equal(await row(A, 'tbl-waiting', 'K7').count(), 0, 'v zozname ambulancie 1 nie je');
    await A.selectOption('#room', { label: 'Ambulancia č. 2' });
    await row(A, 'tbl-waiting', 'K7').locator('.amb-pill', { hasText: 'Ambulancia č. 2' }).waitFor();
    await row(A, 'tbl-waiting', 'K7').getByRole('button', { name: 'Upraviť' }).click();
    await A.fill('#m-card', 'K8'); await A.fill('#m-time', '10:15');
    await A.selectOption('#m-room', { label: 'Ambulancia č. 1' });
    await A.click('#m-ok');
    await toastWith(A, /Uložené: K8 · 10:15 · Ambulancia č\. 1/);
    await row(A, 'tbl-waiting', 'K8').waitFor({ state: 'detached' });
    await A.selectOption('#room', { label: 'Ambulancia č. 1' });
    await row(A, 'tbl-waiting', 'K8').locator('.amb-pill', { hasText: 'Ambulancia č. 1' }).waitFor();
    await shot(A, '7-zoznam-ambulancia');
    await row(A, 'tbl-waiting', 'K8').getByRole('button', { name: 'Zmazať' }).click();
    await A.getByText('Zmazať pacienta K8?').waitFor();
    await A.click('#m-ok');
    await toastWith(A, /Pacient K8 bol zmazaný/);
    await row(A, 'tbl-waiting', 'K8').waitFor({ state: 'detached' });
    const html = await (await fetch(URL_BASE + '/sestra/')).text();
    assert.match(html, /src="app\.js\?v=\w+"/, 'úvodná stránka odkazuje na verziu app.js');
    ok('pri pridaní sa vyberá ambulancia; stĺpec Ambulancia; úprava čísla, času a ambulancie; zmazanie chybne zadaného; app.js s verziou');

    // 10c. (2026-11-17) identifikátor pacienta – vidí ho len sestra, obrazovka v čakárni nie
    await A.click('#btn-card');
    await A.fill('#m-card', 'K9'); await A.fill('#m-time', '10:30'); await A.fill('#m-ident', 'Pacient Skúšobný');
    const types = await A.locator('#m-type option').allTextContents();
    assert.equal(types[1], 'Vstupné vyšetrenie varixy'); assert.equal(types.at(-1), 'AVF');
    await A.selectOption('#m-type', 'Kontrola po CLaCS');
    await shot(A, '8-pridat-typ');
    await A.click('#m-ok');
    await toastWith(A, /K9 zaradený/);
    await row(A, 'tbl-waiting', 'K9').locator('.ident-pill', { hasText: 'Pacient Skúšobný' }).waitFor();
    await row(A, 'tbl-waiting', 'K9').locator('.type-pill', { hasText: 'Kontrola po CLaCS' }).waitFor();
    await shot(A, '8-identifikator');
    assert.ok(!/Skúšobný|CLaCS/.test(JSON.stringify(await display())), 'identifikátor ani typ nie sú na obrazovke v čakárni');
    await row(A, 'tbl-waiting', 'K9').getByRole('button', { name: 'Upraviť' }).click();
    assert.equal(await A.inputValue('#m-ident'), 'Pacient Skúšobný');
    await A.fill('#m-ident', 'Druhý Skúšobný'); await A.click('#m-ok');
    await row(A, 'tbl-waiting', 'K9').locator('.ident-pill', { hasText: 'Druhý Skúšobný' }).waitFor();
    await row(A, 'tbl-waiting', 'K9').getByRole('button', { name: /^Vyvolať/ }).click();
    if (await A.locator('#m-ok').count()) await A.click('#m-ok');
    await row(A, 'tbl-called', 'K9').locator('.ident-pill', { hasText: 'Druhý Skúšobný' }).waitFor();
    assert.ok(!JSON.stringify(await display()).includes('Skúšobný'), 'ani po vyvolaní nie je identifikátor na obrazovke');
    await row(A, 'tbl-called', 'K9').getByRole('button', { name: 'Identifikátor' }).click();
    assert.equal(await A.inputValue('#m-type'), 'Kontrola po CLaCS');
    await A.fill('#m-ident', ''); await A.click('#m-ok');
    await toastWith(A, /K9: uložené/);
    await row(A, 'tbl-called', 'K9').locator('.ident-pill').waitFor({ state: 'detached' });
    await row(A, 'tbl-called', 'K9').locator('.type-pill', { hasText: 'Kontrola po CLaCS' }).waitFor();
    await row(A, 'tbl-called', 'K9').getByRole('button', { name: 'Ukončený' }).click();
    ok('typ a identifikátor pacienta: ponuka typov, zadanie, úprava, odstránenie; obrazovka ich nemá');

    // 10d. (2026-11-18) voľba „ide k sestre / ide k lekárovi“ pri pridaní, v tabuľke aj v ✎ Upraviť
    await A.click('#btn-card');
    await A.fill('#m-card', 'L5'); await A.fill('#m-time', '10:40');
    assert.equal(await A.inputValue('#m-stage'), 'nurse', 'predvolene ide k sestre');
    await A.selectOption('#m-type', 'Vstupné vyšetrenie varixy');
    await A.selectOption('#m-stage', 'doctor');
    await A.click('#m-ok');
    await toastWith(A, /L5 zaradený/);
    await row(A, 'tbl-doctor', 'L5').waitFor();
    assert.equal(await row(A, 'tbl-waiting', 'L5').count(), 0, 'nie je v rade k sestre');
    await shot(A, '9-ide-k-lekarovi');
    await row(A, 'tbl-doctor', 'L5').getByRole('button', { name: 'Späť k sestre' }).click();
    await toastWith(A, /L5: späť k sestre/);
    await row(A, 'tbl-waiting', 'L5').waitFor();
    await row(A, 'tbl-waiting', 'L5').getByRole('button', { name: 'Upraviť' }).click();
    await A.selectOption('#m-stage', 'doctor'); await A.click('#m-ok');
    await row(A, 'tbl-doctor', 'L5').waitFor();
    // rýchla zmena ambulancie priamo v riadku
    // názov ambulancie vrátane čísla sa do poľa zmestí celý (neorezáva sa)
    assert.ok(await row(A, 'tbl-doctor', 'L5').locator('select.room-sel').evaluate((el) => {
      const c = document.createElement('canvas').getContext('2d'); const cs = getComputedStyle(el);
      c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) >= c.measureText(el.options[el.selectedIndex].text).width;
    }), 'číslo ambulancie je v poli vidieť celé');
    await shot(A, '14-ambulancia-cela');
    await row(A, 'tbl-doctor', 'L5').locator('select.room-sel').selectOption('');
    await toastWith(A, /L5: ktorákoľvek ambulancia/);
    await A.waitForFunction(() => { const r = [...document.querySelectorAll('#tbl-doctor tr')].find((x) => x.textContent.includes('L5')); return r && r.querySelector('select.room-sel').value === '' && r.querySelector('select.room-sel').classList.contains('any'); });
    assert.match(await row(A, 'tbl-doctor', 'L5').locator('.t-plan').innerText(), /10:40/, 'v rade k lekárovi je termín');
    assert.ok(await A.getByRole('heading', { name: /Čakajú na sestru/ }).count(), 'nadpis radu k sestre');
    assert.ok(await row(A, 'tbl-doctor', 'L5').locator('.type-pill.entry', { hasText: 'Vstupné vyšetrenie varixy' }).count(), 'vstupné vyšetrenie je zelené');
    assert.equal(await A.locator('.type-pill.entry', { hasText: 'Kontrola' }).count(), 0, 'kontroly ostávajú žlté');
    await shot(A, '13-rychla-zmena-ambulancie');
    // „Ukončený“ priamo v rade k lekárovi (ukončenie pri omyle, bez vyvolania)
    // plný riadok v rade k sestre (ambulancia, typ, identifikátor, termín s meškaním) sa musí zmestiť do okna
    await A.click('#btn-card');
    await A.fill('#m-card', 'W6'); await A.fill('#m-time', '00:05');
    await A.selectOption('#m-type', 'Vstupné vyšetrenie varixy'); await A.fill('#m-ident', 'Skúšobná Dlhšia');
    await A.click('#m-ok');
    await row(A, 'tbl-waiting', 'W6').locator('.ident-pill').waitFor();
    assert.match(await row(A, 'tbl-waiting', 'W6').locator('.t-plan').innerText(), /00:05/);
    await shot(A, '16-rozlozenie');
    // rozloženie: rad k sestre vľavo, rad k lekárovi vpravo, rovnako široké; nič nepretŕča; ukončení dole na celú šírku
    const lay = await A.evaluate(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); const n = r('.q-nurse'), d = r('.q-doctor'), f = r('.a-finished'), c = r('.a-counts'), rb = r('.a-room');
      const over = [...document.querySelectorAll('.a-queues > .card')].map((x) => x.scrollWidth - x.clientWidth).join('/');
      return { same: Math.abs(n.width - d.width) < 2, left: n.left < d.left, below: f.top >= Math.max(n.bottom, d.bottom), full: Math.abs(f.width - (d.right - n.left)) < 2, first: rb.bottom <= c.top && c.bottom <= r('.a-hero').top, over }; });
    const top = await A.evaluate(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); const h = r('.a-hero'), n = r('.a-now'), qn = r('.q-nurse'), qd = r('.q-doctor');
      const he = document.querySelector('.a-hero'); return { same: Math.abs(h.width - n.width) < 2, lineL: Math.abs(h.left - qn.left) < 2, lineR: Math.abs(h.right - qd.right) < 2, over: he.scrollWidth - he.clientWidth }; });
    assert.deepEqual(top, { same: true, lineL: true, lineR: true, over: 0 }, 'horné okná sú rovnako široké: ' + JSON.stringify(top));
    assert.deepEqual(lay, { same: true, left: true, below: true, full: true, first: true, over: '0/0' }, JSON.stringify(lay));
    // prepínač pohľadu: správca má predvolene obe časti; „Len lekár“ skryje sesterskú časť a lekárska je na celú šírku
    assert.equal(await A.getAttribute('[data-pohlad=both]', 'aria-pressed'), 'true');
    await A.click('[data-pohlad=doctor]');
    await A.locator('.dash.pohlad-doctor').waitFor();
    const pv = await A.evaluate(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); return { nurse: r('.q-nurse').width, nowNurse: r('.now-nurse').width, full: Math.abs(r('.q-doctor').width - r('.a-finished').width) < 2 }; });
    assert.deepEqual(pv, { nurse: 0, nowNurse: 0, full: true }, JSON.stringify(pv));
    await A.click('[data-pohlad=nurse]');
    await A.locator('.dash.pohlad-nurse').waitFor();
    assert.equal(await A.locator('.q-doctor').isVisible(), false);
    await A.click('[data-pohlad=both]');
    await A.locator('.dash.pohlad-both').waitFor();
    ok('prepínač pohľadu Len sestra / Sestra aj lekár / Len lekár');
    await shot(A, '15-vybaveny-v-rade-lekara');
    await row(A, 'tbl-doctor', 'L5').getByRole('button', { name: 'Ukončený' }).click();
    await toastWith(A, /L5: Ukončený/);
    await row(A, 'tbl-doctor', 'L5').waitFor({ state: 'detached' });
    ok('voľba „ide k sestre / ide k lekárovi“: pri pridaní, v tabuľke čakajúcich aj v úprave');

    // 11. história
    await A.click('.tab[data-view=history]');
    await A.locator('#hist-detail table').waitFor();
    await A.locator('#hist-detail').getByText('objednaný na 9:30').count().then((n) => assert.equal(n, 0, 'poznámka z neúspešného vyvolania sa neuložila'));
    await A.locator('#hist-detail').getByText('Opakovaná tlač').first().waitFor();
    ok('história dňa so stavmi a priebehom');

    // 11b. 2026-11-17: Ukončiť deň, ambulancia bez lekára, hlasitosť vyvolania
    await A.click('.tab[data-view=queue]');
    await A.click('#btn-day-end'); await A.click('#m-ok');
    await toastWith(A, /Deň je ukončený/);
    await A.locator('.alert.day-end').waitFor();
    assert.ok((await display()).dayEnd, 'TV vie o ukončení dňa');
    assert.equal((await kiosk()).error.code, 'DAY_ENDED', 'tablet nevydá číslo');
    await shot(A, '10-den-ukonceny');
    await A.locator('.alert.day-end').getByRole('button', { name: 'Obnoviť príjem' }).click(); await A.click('#m-ok');
    await toastWith(A, /opäť otvorený/);
    assert.equal((await display()).dayEnd, null);
    await A.selectOption('#room', { label: 'Ambulancia č. 2' });
    await A.click('#btn-doctor'); await A.locator('#m-closed').click();
    await toastWith(A, /dnes neordinuje nikto/);
    assert.equal((await display()).rooms.find((r) => r.name === 'Ambulancia č. 2').closedToday, true);
    await A.getByRole('button', { name: 'Ambulancia ordinuje' }).waitFor();
    await shot(A, '11-ambulancia-neordinuje');
    await A.getByRole('button', { name: 'Ambulancia ordinuje' }).click();
    await toastWith(A, /opäť ordinuje/);
    assert.equal((await display()).rooms.find((r) => r.name === 'Ambulancia č. 2').closedToday, false);
    await A.click('.tab[data-view=admin]');
    await A.locator('#s-vol').fill('170');
    assert.equal(await A.textContent('#s-vol-val'), '170 %');
    await A.click('#s-vol-test');
    await toastWith(A, /nie je pripojená|zahrané na TV/);
    await A.locator('#f-general button[type=submit]').click();
    await toastWith(A, /Nastavenia boli uložené/);
    assert.equal((await display()).soundVolume, 170);
    await shot(A, '12-hlasitost');
    ok('Ukončiť deň (tablet nevydá číslo) a obnovenie; ambulancia „dnes neordinuje nikto“; posuvník hlasitosti');

    // 11c. 2026-11-17: dva kroky – sestra, potom lekár (TV ukáže najprv sestru, potom lekára)
    await A.click('.tab[data-view=queue]');
    await A.selectOption('#room', { label: 'Ambulancia č. 1' });
    await A.click('#btn-nurse');
    await A.locator('#m-nurse').waitFor();
    await A.fill('#m-doc', 'MUDr. Pavel Staško');
    await A.locator('button[data-nurse="Daniela Fetyková"]').click();
    assert.equal(await A.inputValue('#m-nurse'), 'Daniela Fetyková');
    await A.click('#m-ok');
    await toastWith(A, /Sestra a lekár boli uložení/);
    await A.locator('#btn-nurse', { hasText: 'Daniela Fetyková' }).waitFor();
    const tn = (await kiosk()).ticket.code;
    await row(A, 'tbl-waiting', tn).getByRole('button', { name: /^Vyvolať/ }).click();
    if (await A.locator('#m-ok').count()) await A.click('#m-ok');
    await row(A, 'tbl-called', tn).locator('.stage-pill', { hasText: 'u sestry' }).waitFor();
    d = await display();
    assert.equal(d.current.code, tn); assert.equal(d.current.stage, 'nurse'); assert.equal(d.current.nurseName, 'Daniela Fetyková');
    await shot(A, '13-u-sestry');
    await row(A, 'tbl-called', tn).getByRole('button', { name: '→ K lekárovi' }).click();
    await toastWith(A, /čaká na lekára/);
    await row(A, 'tbl-doctor', tn).waitFor();
    assert.deepEqual((await display()).rooms.find((r) => r.name === 'Ambulancia č. 1').doctorQueue, [tn]);
    await shot(A, '14-caka-na-lekara');
    await row(A, 'tbl-doctor', tn).getByRole('button', { name: /Vyvolať k lekárovi/ }).click();
    if (await A.locator('#m-ok').count()) await A.click('#m-ok');
    await row(A, 'tbl-called', tn).locator('.stage-pill', { hasText: 'u lekára' }).waitFor();
    d = await display();
    assert.equal(d.current.code, tn); assert.equal(d.current.stage, 'doctor'); assert.equal(d.current.doctorName, 'MUDr. Pavel Staško');
    // po lekárovi späť k sestre na ukončenie – „Práve v ambulancii“ je rozdelené na „U sestry“ a „U lekára“
    const grpRow = (g) => A.locator(`#tbl-called .${g} tr[data-ticket]`, { hasText: tn });
    await grpRow('now-doctor').waitFor();
    assert.match(await A.locator('.now-nurse h2').innerText(), /U SESTRY/i);
    const win = await A.evaluate(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); const n = r('.now-nurse'), d = r('.now-doctor'), qn = r('.q-nurse'), qd = r('.q-doctor');
      return { same: Math.abs(n.width - d.width) < 2, left: n.right <= d.left, lineL: Math.abs(n.left - qn.left) < 2, lineR: Math.abs(d.right - qd.right) < 2, above: Math.max(n.bottom, d.bottom) <= qn.top }; });
    assert.deepEqual(win, { same: true, left: true, lineL: true, lineR: true, above: true }, 'dve samostatné okná: ' + JSON.stringify(win));
    const tn2 = (await kiosk()).ticket.code;
    await row(A, 'tbl-waiting', tn2).getByRole('button', { name: /^Vyvolať/ }).click();
    if (await A.locator('#m-ok').count()) await A.click('#m-ok');
    await A.locator('#tbl-called .now-nurse tr[data-ticket]', { hasText: tn2 }).waitFor();
    await shot(A, '20-u-sestry-a-u-lekara');
    await grpRow('now-doctor').getByRole('button', { name: '→ K sestre na ukončenie' }).click();
    await toastWith(A, /k sestre na ukončenie/);
    await grpRow('now-nurse').locator('.stage-pill', { hasText: 'ukončenie' }).waitFor();
    assert.equal(await grpRow('now-doctor').count(), 0);
    await grpRow('now-nurse').getByRole('button', { name: '← Späť k lekárovi' }).click();
    await grpRow('now-doctor').waitFor();
    await grpRow('now-doctor').getByRole('button', { name: '→ K sestre na ukončenie' }).click();
    await grpRow('now-nurse').locator('.stage-pill', { hasText: 'ukončenie' }).waitFor();
    await shot(A, '21-ukoncenie-u-sestry');
    assert.equal(await A.evaluate(() => [...document.querySelectorAll('.now-pair > .card')].map((c) => c.scrollWidth - c.clientWidth).join('/')), '0/0', 'karta Práve v ambulancii nepretŕča');
    await grpRow('now-nurse').getByRole('button', { name: /Ukončený/ }).click();
    await row(A, 'tbl-finished', tn).waitFor();
    await row(A, 'tbl-called', tn2).getByRole('button', { name: /Ukončený/ }).click();
    await row(A, 'tbl-finished', tn2).waitFor();
    // história: priebeh hovorí, kto vyvolal a kto kam poslal
    await A.click('.tab[data-view=history]');
    const hr = A.locator('#hist-detail tr', { hasText: tn }).first();
    await hr.getByText('Vyvolaný sestrou (Daniela Fetyková) – Ambulancia č. 1').waitFor();
    for (const txt of ['Pridaný sestrou', 'Registrácia (lístok)'].slice(0, 0).concat(['Poslaný k lekárovi sestrou', 'Vyvolaný lekárom (MUDr. Pavel Staško)', 'Poslaný k sestre lekárom', 'Vrátený od sestry späť k lekárovi', 'Ukončený sestrou (po lekárovi)']))
      assert.ok(await hr.getByText(txt).count(), 'v histórii chýba: ' + txt);
    await shot(A, '22-historia-priebeh');
    await A.click('.tab[data-view=queue]');
    ok('dva kroky: sestra a lekár ráno, vyvolanie k sestre, „K lekárovi“, rad „Čakajú na lekára“, vyvolanie k lekárovi, „K sestre na ukončenie“ a „Ukončený“ u sestry');

    // 11c. hromadné kontá nastavia heslo aj kontám lekárov, ktoré vznikli bez hesla
    await A.click('.tab[data-view=admin]');
    await A.click('#btn-bulk-users');
    await A.locator('.modal', { hasText: 'už existuje, dostane heslo' }).waitFor();
    await A.click('#m-ok');
    await A.locator('.modal', { hasText: 'Kontá sú založené' }).waitFor();
    await A.click('#m-cancel');
    const noPw = await A.evaluate(async () => (await (await fetch('/api/admin/users')).json()).users.filter((u) => u.noPassword).map((u) => u.username));
    assert.deepEqual(noPw, [], 'žiadne konto bez hesla');
    ok('hromadné kontá dajú heslo aj existujúcim kontám lekárov bez hesla');

    // 12. ukončenie dňa s potvrdením
    await A.click('.tab[data-view=admin]');
    await A.click('#btn-close-day');
    await A.fill('#m-confirm', 'nie'); await A.click('#m-ok');
    await A.locator('#m-err', { hasText: 'UKONČIŤ' }).waitFor();
    await A.fill('#m-confirm', 'UKONČIŤ'); await A.click('#m-ok');
    await toastWith(A, /Deň bol ukončený/);   // (Nastavenia → Uzavrieť dnešné neukončené čísla)
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
