#!/usr/bin/env node
// End-to-end test: platba pacienta → doklad VRP2 → tlač, celé z aplikácie SESTRA (scenár 10 zo zadania 2026-11-27).
// Beží skutočný server, skutočný lokálny agent (agent/src/index.js ako samostatný proces) so SIMULÁTOROM VRP2
// a tlačou do súboru. S ostrou VRP2 Finančnej správy tento test nekomunikuje a nevytvára v nej žiadne tržby.
// Spustenie:  node apps/sestra/test/e2e-platba.js      (ADNA_SCREENSHOTS=/cesta uloží snímky)
'use strict';
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PORT = Number(process.env.ADNA_TEST_PORT || 8183);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'adna-platba-e2e-'));
const AGENT_DIR = path.join(DATA, 'agent');
const PRINT_DIR = path.join(DATA, 'tlac');
const SHOTS = process.env.ADNA_SCREENSHOTS || '';
const PASSWORD = 'Sestra-heslo-2026';
const SIM_CODE = '00000000000000001';   // vymyslený kód len pre simulátor

let server = null, agent = null;
async function waitFor(fn, ms, msg) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('Čas vypršal: ' + msg);
}
function startServer() {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], { cwd: path.join(ROOT, 'server'), env: { ...process.env, ADNA_PORT: String(PORT), ADNA_DATA_DIR: DATA, ADNA_QUIET: '1' }, stdio: 'ignore' });
  return waitFor(async () => (await fetch(URL_BASE + '/api/health')).ok, 10000, 'server sa nespustil');
}
function startAgent(token, tlac = { typ: 'subor', priecinok: PRINT_DIR }) {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  const cfg = path.join(AGENT_DIR, 'konfiguracia.json');
  fs.writeFileSync(cfg, JSON.stringify({ nazov: 'Recepcia test', server: URL_BASE, token, rezim: 'sim', data: path.join(AGENT_DIR, 'data'),
    simulator: { pokladnice: [{ code: SIM_CODE, companyName: 'AdNa s.r.o.', ico: '' }], aktivna: SIM_CODE }, tlac }));
  agent = spawn(process.execPath, [path.join(ROOT, 'agent', 'src', 'index.js'), 'spustit', '--konfiguracia', cfg], { stdio: 'ignore' });
}
const kill = (p) => new Promise((r) => { if (!p) return r(); p.once('exit', r); p.kill('SIGKILL'); });

let cookie = '';
async function call(method, p, body) {
  const res = await fetch(URL_BASE + p, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}
let step = 0;
const ok = (m) => console.log(`ok ${++step} - ${m}`);
async function shot(page, name) { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `platba-${name}.png`), fullPage: true }); }
const row = (page, table, code) => page.locator(`#${table} tr`, { hasText: code });

(async () => {
  let browser;
  try {
    await startServer();
    // --- príprava cez API správcu (to, čo správca raz nastaví v Nastaveniach) ---
    const code = fs.readFileSync(path.join(DATA, 'SETUP-KOD.txt'), 'utf8').match(/KOD:\s*(\S+)/)[1];
    await call('POST', '/api/setup', { setupCode: code, password: PASSWORD });
    await call('POST', '/api/auth/login', { username: 'admin', password: PASSWORD });
    const room = (await call('GET', '/api/admin/rooms')).rooms[0];
    await call('POST', '/api/admin/users', { username: 'sestra1', password: PASSWORD, roomId: room.id, nurseName: 'Daniela Fetyková' });
    const B = await call('GET', '/api/admin/billing');
    const [adna, uz] = B.companies;
    const ag = await call('POST', '/api/admin/billing/agents', { name: 'Recepcia test' });
    await call('POST', '/api/admin/billing/registers', { companyId: adna.id, label: 'AdNa – recepcia', vrpCode: SIM_CODE, agentId: ag.agent.id, printerName: 'Recepcia-80mm', roomIds: [room.id] });
    await call('POST', '/api/admin/billing/registers', { companyId: uz.id, label: 'Ultrazvuk – recepcia', vrpCode: '', agentId: ag.agent.id, printerName: 'Recepcia-80mm', roomIds: [room.id] });
    await call('POST', '/api/admin/billing/price-import', { companyId: adna.id, text: 'Komplexné cievne vyšetrenie - samoplatca\t\t\t150\t150\t2026-09-01\t\nEVLA - odstránenie kŕčových žíl\t\t\t1000\t1000\t2026-03-31\t\nEVLA (VSM+VSP)\t\t\t1400\t1400\t2026-08-31\t\nCLaCS - odstránenie varixov (Laser+sklerotizácia), 1 impulz\t\t\t4,1\t4,1\t2026-08-31\t' });
    const items = (await call('GET', '/api/admin/billing')).priceItems;
    const it = (n) => items.find((i) => i.name.startsWith(n)).id;
    await call('POST', '/api/admin/billing/procedures', { name: 'Cievne vyšetrenie', sortOrder: 1, items: [{ variant: '', priceItemId: it('Komplexné') }] });
    await call('POST', '/api/admin/billing/procedures', { name: 'EVLA', sortOrder: 2, items: [{ variant: 'one', priceItemId: it('EVLA - ') }, { variant: 'both', priceItemId: it('EVLA (VSM') }] });
    await call('POST', '/api/admin/billing/procedures', { name: 'CLaCS', sortOrder: 3, items: [{ variant: '', priceItemId: it('CLaCS'), qty: 100 }] });
    await call('POST', '/api/admin/billing/procedures', { name: 'Sklerotizácia', sortOrder: 4, items: [] });
    await call('PUT', '/api/admin/billing/config', { enabled: true });
    startAgent(ag.token);
    await waitFor(async () => (await call('GET', '/api/admin/billing')).agents[0].online, 15000, 'agent sa nepripojil');
    ok('správca nastavil spoločnosti, pokladnice, cenník z exportu VRP2 a výkony; agent (simulátor) sa pripojil');

    browser = await chromium.launch(process.env.ADNA_CHROME ? { executablePath: process.env.ADNA_CHROME } : {});
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'sk-SK' });
    const A = await ctx.newPage();
    const errors = [], dialogs = [], popups = [];
    A.on('pageerror', (e) => errors.push(String(e)));
    A.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    ctx.on('page', (p) => { if (p !== A) popups.push(p.url()); });
    await A.addInitScript(() => { window.__printCalls = 0; window.print = () => { window.__printCalls++; }; });

    await A.goto(URL_BASE + '/sestra/');
    await A.fill('#un', 'sestra1');
    await A.fill('#pw', PASSWORD);
    await A.click('button[type=submit]');
    await A.locator('#conn.conn-online').waitFor();
    if (await A.locator('#m-cancel').count()) await A.click('#m-cancel');
    const addPatient = async (no, time) => { await call('POST', '/api/staff/cards', { cardNo: no, plannedTime: time, roomId: room.id }); await row(A, 'tbl-waiting', no).waitFor(); };

    // --- 1. bez priamej úhrady: pôvodné ukončenie ---
    await addPatient('K1', '23:01');
    await row(A, 'tbl-waiting', 'K1').getByRole('button', { name: /Vyvolať/ }).first().click();
    if (await A.locator('#m-ok').count()) await A.click('#m-ok');
    await row(A, 'tbl-called', 'K1').waitFor();
    await row(A, 'tbl-called', 'K1').getByRole('button', { name: /Ukončený/ }).click();
    await A.getByRole('heading', { name: 'Ukončiť pacienta K1' }).waitFor();
    assert.ok(await A.locator('input[name=f-paid][value="0"]').isChecked(), 'predvolené je Bez priamej úhrady');
    await shot(A, '1-bez-uhrady');
    await A.getByRole('button', { name: 'Ukončiť pacienta', exact: true }).click();
    await row(A, 'tbl-finished', 'K1').waitFor();
    assert.equal(await row(A, 'tbl-finished', 'K1').locator('.pay-line').count(), 0);
    ok('návšteva bez priamej úhrady sa ukončí tlačidlom „Ukončiť pacienta“ – bez platby');

    // --- 2. dva výkony, karta: zamietnutá → schválená ---
    await addPatient('K2', '23:02');
    await row(A, 'tbl-waiting', 'K2').getByRole('button', { name: /Vyvolať/ }).first().click();
    if (await A.locator('#m-ok').count()) await A.click('#m-ok');
    await row(A, 'tbl-called', 'K2').getByRole('button', { name: /Ukončený/ }).click();
    await A.getByText('Platba pacienta').click();
    await A.locator('.pay-regs').waitFor();   // recepciu používajú obe spoločnosti → treba vybrať
    assert.equal(await A.locator('#f-pay').isDisabled(), true);
    await A.locator('.pay-regs label', { hasText: 'AdNa s.r.o.' }).click();
    assert.equal((await A.textContent('#f-company')).trim(), 'AdNa s.r.o.');
    await A.getByText('Skúšobný režim (simulátor VRP2)').waitFor();
    await A.getByText('Bez položky VRP2').waitFor();   // Sklerotizácia nemá mapovanie – vidno pred platbou
    await A.locator('tr', { hasText: 'Cievne vyšetrenie' }).locator('input[type=checkbox]').check();
    await A.locator('tr', { hasText: 'EVLA' }).locator('input[type=checkbox]').check();
    await A.getByText('vyberte jednu alebo obe končatiny').waitFor();
    await A.locator('select[data-var]').selectOption('both');
    assert.equal((await A.textContent('#f-total')).replace(/\s/g, ''), '1550,00€');
    await A.locator('.pay-methods label', { hasText: 'Karta' }).click();
    await shot(A, '2-karta');
    await A.click('#f-card-no');
    await A.getByText('Platba kartou bola zamietnutá – nič sa nezaevidovalo.').waitFor();
    assert.equal((await call('GET', '/api/staff/state')).billing.payments && Object.keys((await call('GET', '/api/staff/state')).billing.payments).length, 0, 'zamietnutá karta nič nezaevidovala');
    await A.locator('.pay-methods label', { hasText: 'Karta' }).click();
    assert.equal(await A.locator('#f-pay').isDisabled(), true, 'bez potvrdenia terminálu nejde');
    await A.locator('#f-card-ok').check();
    const pay = A.locator('#f-pay');
    assert.equal((await pay.textContent()).trim(), 'Ukončiť pacienta a vytlačiť doklad');
    await pay.dblclick();   // dvojklik
    await row(A, 'tbl-finished', 'K2').locator('.pay-line', { hasText: 'odoslané na tlačiareň' }).waitFor({ timeout: 20000 });
    const line = await row(A, 'tbl-finished', 'K2').locator('.pay-line').textContent();
    assert.match(line, /SIMULÁCIA · doklad nie je fiskalizovaný · odoslané na tlačiareň\./);
    assert.match(line, /1\s550,00\s€ · karta · ID SIM-/);
    await shot(A, '3-doklad-vydany');
    const st = await call('GET', '/api/staff/state');
    assert.equal(Object.keys(st.billing.payments).length, 1, 'jedna platba');
    const printed = fs.readdirSync(PRINT_DIR);
    assert.equal(printed.length, 1, 'jeden výtlačok');
    assert.ok(fs.readFileSync(path.join(PRINT_DIR, printed[0]), 'latin1').startsWith('%PDF'));
    assert.equal(await row(A, 'tbl-finished', 'K2').getByRole('button', { name: /Vrátiť/ }).count(), 0);
    ok('dva výkony + karta (najprv zamietnutá, potom schválená, dvojklik): jedna platba, jeden doklad, jeden výtlačok – všetko z aplikácie Sestra');

    // --- 3. hotovosť: zaokrúhlenie a výdavok ---
    await addPatient('K3', '23:03');
    await row(A, 'tbl-waiting', 'K3').getByRole('button', { name: /Vyvolať/ }).first().click();
    if (await A.locator('#m-ok').count()) await A.click('#m-ok');
    await row(A, 'tbl-called', 'K3').getByRole('button', { name: /Ukončený/ }).click();
    await A.getByText('Platba pacienta').click();
    await A.locator('.pay-regs label', { hasText: 'AdNa s.r.o.' }).click();
    await A.locator('tr', { hasText: 'CLaCS' }).locator('input[type=checkbox]').check();
    const qty = A.locator('tr', { hasText: 'CLaCS' }).locator('input[type=number]');
    assert.equal(await qty.inputValue(), '100');
    await qty.fill('37');   // 37 × 4,10 € = 151,70 €
    assert.equal((await A.textContent('#f-total')).replace(/\s/g, ''), '151,70€');
    await A.locator('.pay-methods label', { hasText: 'Hotovosť' }).click();
    await A.fill('#f-received', '100');
    await A.getByText('prijatá suma je nízka').waitFor();
    await A.fill('#f-received', '200');
    assert.equal((await A.textContent('#f-change')).replace(/\s/g, ''), '48,30€');
    assert.equal(await A.locator('#f-pay').isDisabled(), true);
    await A.locator('#f-confirm').check();
    await shot(A, '4-hotovost');
    await A.click('#f-pay');
    await row(A, 'tbl-finished', 'K3').locator('.pay-line', { hasText: 'odoslané na tlačiareň' }).waitFor({ timeout: 20000 });
    ok('hotovosť: suma 151,70 €, prijaté 200 €, výdavok 48,30 €; doklad vytlačený');

    // --- 4. obnovenie stránky počas formulára nevytvorí nič; po obnovení stav ostáva ---
    await A.reload();
    await A.locator('#conn.conn-online').waitFor();
    await A.locator('#m-cancel').click({ timeout: 3000 }).catch(() => {});   // výzva na lekára dňa → „Neskôr“
    await row(A, 'tbl-finished', 'K2').locator('.pay-line', { hasText: 'odoslané na tlačiareň' }).waitFor();
    assert.equal(Object.keys((await call('GET', '/api/staff/state')).billing.payments).length, 2);
    ok('po obnovení stránky ostáva stav dokladov, žiadna duplicita');

    // --- 5. chyba tlače → Doklady na doriešenie → Zopakovať tlač ---
    await kill(agent);
    startAgent(ag.token, { typ: 'subor', priecinok: PRINT_DIR, chyba: 'Došiel papier' });
    await addPatient('K4', '23:04');
    await row(A, 'tbl-waiting', 'K4').getByRole('button', { name: /Vyvolať/ }).first().click();
    if (await A.locator('#m-ok').count()) await A.click('#m-ok');
    await row(A, 'tbl-called', 'K4').getByRole('button', { name: /Ukončený/ }).click();
    await A.getByText('Platba pacienta').click();
    await A.locator('.pay-regs label', { hasText: 'AdNa s.r.o.' }).click();
    await A.locator('tr', { hasText: 'Cievne vyšetrenie' }).locator('input[type=checkbox]').check();
    await A.locator('.pay-methods label', { hasText: 'Karta' }).click();
    await A.locator('#f-card-ok').check();
    await A.click('#f-pay');
    const rr = A.locator('#tbl-receipts tr', { hasText: 'K4' });
    await rr.getByText('chyba tlače').waitFor({ timeout: 25000 });
    await rr.getByText('✓ doklad vydaný').waitFor();
    await shot(A, '5-doklady-na-doriesenie');
    const before = fs.readdirSync(PRINT_DIR).length;
    await kill(agent);
    startAgent(ag.token);
    await rr.getByRole('button', { name: /Zopakovať tlač/ }).click();
    await row(A, 'tbl-finished', 'K4').locator('.pay-line', { hasText: 'odoslané na tlačiareň' }).waitFor({ timeout: 25000 });
    await waitFor(async () => (await A.locator('#tbl-receipts tr', { hasText: 'K4' }).count()) === 0, 8000, 'doklad nezmizol zo zoznamu');
    const files = fs.readdirSync(PRINT_DIR);
    assert.equal(files.length, before + 1); assert.ok(files.some((f) => f.includes('-copy')), 'vytlačila sa kópia pôvodného dokladu');
    assert.equal(Object.keys((await call('GET', '/api/staff/state')).billing.payments).length, 3, 'žiadna nová platba ani doklad');
    ok('chyba tlače: doklad ostal vydaný, „Zopakovať tlač“ vytlačila kópiu toho istého dokladu');

    // --- 6. história: úhrada aj ID dokladu ---
    await A.locator('.tab[data-view=history]').click();
    await A.locator('.pay-hist', { hasText: 'doklad ID' }).first().waitFor();
    const hist = await A.locator('tr', { hasText: 'K2' }).locator('.pay-hist').textContent();
    assert.match(hist, /Úhrada 1\s550,00\s€/); assert.match(hist, /doklad ID SIM-/); assert.match(hist, /Daniela Fetyková/);
    await shot(A, '6-historia');
    ok('v histórii návštevy je úhrada, kto ju potvrdil a ID dokladu');

    // --- 7. správca: Nastavenia → pokladnice, skúšobná tlač, riešenie výnimky ---
    const ctxB = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'sk-SK' });
    const Bp = await ctxB.newPage();
    Bp.on('pageerror', (e) => errors.push('admin: ' + String(e)));
    await Bp.goto(URL_BASE + '/sestra/');
    await Bp.fill('#un', 'admin'); await Bp.fill('#pw', PASSWORD); await Bp.click('button[type=submit]');
    await Bp.locator('#conn.conn-online').waitFor();
    await Bp.locator('#m-cancel').click({ timeout: 3000 }).catch(() => {});
    await Bp.locator('.tab[data-view=admin]').click();
    await Bp.locator('#tbl-registers tr', { hasText: 'SIMULÁCIA' }).first().waitFor();
    await Bp.locator('#tbl-agents').getByText('✓ pripojený').waitFor();
    assert.equal(await Bp.locator('#tbl-prices tbody tr').count(), 4);
    const nPrint = fs.readdirSync(PRINT_DIR).length;
    await Bp.locator('#tbl-registers tr').nth(1).getByRole('button', { name: 'Skúšobná tlač' }).click();
    await Bp.locator('.toast', { hasText: 'Skúšobná stránka odoslaná na tlačiareň' }).waitFor({ timeout: 20000 });
    assert.ok(fs.readdirSync(PRINT_DIR).some((f) => f.includes('skusobna-tlac'))); assert.equal(fs.readdirSync(PRINT_DIR).length, nPrint + 1);
    assert.equal(Object.keys((await call('GET', '/api/staff/state')).billing.payments).length, 3, 'skúšobná tlač nevytvorila platbu');
    await Bp.locator('#tbl-registers tr').nth(1).getByRole('button', { name: /Zapnúť ostrý režim/ }).click();
    await Bp.fill('#lv-conf', 'OSTRÁ'); await Bp.click('#m-ok');
    await Bp.locator('#m-err', { hasText: 'IČO' }).waitFor();   // bez IČO spoločnosti ostrý režim nejde
    await Bp.click('#m-cancel');
    await shot(Bp, '7-nastavenia');
    await ctxB.close();
    ok('správca: nastavenia pokladníc, stav agenta, skúšobná tlač bez tržby, ostrý režim len vedome');

    assert.deepEqual(errors, [], 'žiadne chyby JavaScriptu');
    assert.deepEqual(dialogs, [], 'žiadny dialóg prehliadača');
    assert.deepEqual(popups, [], 'žiadne nové okno (VRP2, PDF)');
    assert.equal(await A.evaluate(() => window.__printCalls), 0, 'žiadny dialóg tlače');
    ok('celý priebeh bez prepnutia do VRP2, bez sťahovania PDF a bez dialógu tlače');
    console.log(`\n${step}/${step} prešlo`);
  } catch (e) {
    console.error('not ok - ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    await kill(agent); await kill(server);
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})();
