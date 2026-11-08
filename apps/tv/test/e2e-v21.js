// E2E v2.1: dve ambulancie s vlastnými kontami, spoločná TV, hlásenie predĺženého výkonu. Spustenie: node apps/tv/test/e2e-v21.js
'use strict';
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SHOTS = process.env.ADNA_SHOTS || path.join(os.tmpdir(), 'adna-shots');
const PORT = Number(process.env.ADNA_TEST_PORT || 8185);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adna-v21-e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc = null, ok = 0;
async function step(name, fn) { try { await fn(); ok++; console.log('OK   ' + name); } catch (e) { console.log('FAIL ' + name + '\n     ' + e.message); throw e; } }
function cl() {
  let cookie = '';
  return async (method, p, body) => {
    const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(d)}`);
    return d;
  };
}
const hm = (m) => new Intl.DateTimeFormat('sk-SK', { timeZone: 'Europe/Bratislava', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.now() + m * 60000));

(async () => {
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server/src/index.js')], {
    env: { ...process.env, ADNA_PORT: String(PORT), ADNA_DATA_DIR: dataDir, ADNA_QUIET: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(100); }
  const admin = cl();
  const code = fs.readFileSync(path.join(dataDir, 'SETUP-KOD.txt'), 'utf8').match(/KOD:\s*(\S+)/)[1];
  await admin('POST', '/api/setup', { setupCode: code, password: 'Admin-heslo-0001' });
  await admin('POST', '/api/auth/login', { username: 'personal', password: 'Admin-heslo-0001' });
  const rooms = (await admin('GET', '/api/admin/rooms')).rooms;
  await admin('PUT', '/api/admin/settings', { news: { enabled: false } });
  fs.mkdirSync(SHOTS, { recursive: true });
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];

  await step('administrácia: vytvorenie kont pre dve ambulancie', async () => {
    const pa = await b.newPage({ viewport: { width: 1600, height: 1100 } }); pa.on('pageerror', (e) => errors.push(String(e)));
    await pa.goto(BASE + '/sestra/');
    await pa.fill('#un', 'personal'); await pa.fill('#pw', 'Admin-heslo-0001'); await pa.keyboard.press('Enter');
    await pa.waitForSelector('#btn-card');
    await pa.waitForSelector('#m-doc'); await pa.click('#m-cancel');      // vedúca sestra: lekára zadajú ambulancie
    await pa.click('button[data-view="admin"]');
    await pa.waitForSelector('#f-user');
    for (const [n, i] of [['ambulancia1', 0], ['ambulancia2', 1]]) {
      await pa.fill('#nu-name', n); await pa.selectOption('#nu-room', String(rooms[i].id)); await pa.fill('#nu-pw', 'Heslo-' + n);
      await pa.click('#f-user button[type=submit]');
      await pa.waitForFunction((n) => document.getElementById('tbl-users') && document.getElementById('tbl-users').innerText.includes(n), n);
    }
    await pa.locator('#sec-users').screenshot({ path: path.join(SHOTS, 'sestra21-konta.png') });
    await pa.close();
  });

  const s1 = await b.newPage({ viewport: { width: 1600, height: 1000 } }); s1.on('pageerror', (e) => errors.push(String(e)));
  const s2 = await b.newPage({ viewport: { width: 1600, height: 1000 } }); s2.on('pageerror', (e) => errors.push(String(e)));
  const tv = await b.newPage({ viewport: { width: 1920, height: 1080 } }); tv.on('pageerror', (e) => { errors.push(String(e)); if (process.env.DBG) console.log('TV ERR', String(e)); });
  // náhradný slovenský hlas (Chromium v teste žiadne hlasy nemá) – zaznamená, čo by TV povedala
  await tv.addInitScript(() => {
    window.__said = [];
    const v = { name: 'Microsoft Viktoria Online (Natural) - Slovak (Slovakia)', lang: 'sk-SK' };
    window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    Object.defineProperty(window, 'speechSynthesis', { value: { getVoices: () => [{ name: 'Google US English', lang: 'en-US' }, v], speak: (u) => window.__said.push([u.text, u.voice && u.voice.name, Date.now()]), cancel() {}, onvoiceschanged: null } });
  });
  const addPatient = async (p, c, m) => {
    await p.click('#btn-card'); await p.fill('#m-card', c); if (m != null) await p.fill('#m-time', hm(m)); await p.click('#m-ok');
    await p.waitForFunction((c) => !document.querySelector('.modal') && document.getElementById('tbl-waiting') && [...document.querySelectorAll('#tbl-waiting td.code')].some((td) => td.firstChild.textContent === c), c);
  };

  await step('každá sestra sa prihlási svojím kontom a pridáva svojich pacientov', async () => {
    for (const [p, n] of [[s1, 'ambulancia1'], [s2, 'ambulancia2']]) {
      await p.goto(BASE + '/sestra/');
      await p.fill('#un', n); await p.fill('#pw', 'Heslo-' + n); await p.keyboard.press('Enter');
      await p.waitForSelector('#m-doc');                 // povinné: kto dnes ordinuje
      await p.click(`button[data-doc="${n === 'ambulancia1' ? 'MUDr. Pavel Staško, PhD., MHA, MPH' : 'MUDr. Adela Czetöová'}"]`);
      await p.click('#m-ok');
      await p.waitForFunction(() => !document.querySelector('.modal') && /MUDr/.test(document.getElementById('btn-doctor').textContent));
    }
    assert.match(await s1.locator('#who').innerText(), /ambulancia1 · Ambulancia č. 1/);
    for (const [c, m] of [['1', -25], ['2', -5], ['3', 10], ['4', 30]]) await addPatient(s1, c, m);
    for (const [c, m] of [['A', -15], ['B', 0], ['C', 20]]) await addPatient(s2, c, m);
    const w1 = await s1.$$eval('#tbl-waiting td.code', (l) => l.map((td) => td.firstChild.textContent));
    assert.deepEqual(w1, ['1', '2', '3', '4'], 'sestra 1 vidí len svojich');
    await s2.click('#btn-card'); await s2.fill('#m-card', '1'); await s2.fill('#m-time', hm(0)); await s2.click('#m-ok');
    await s2.waitForFunction(() => /Označenie 1 je už v zozname \(Ambulancia č. 1\)/.test(document.getElementById('m-err').textContent));
    await s2.click('#m-cancel');
  });

  await step('spoločná TV: kto vyvolá prvý, ten sa zobrazí; poradie oboch pracovísk', async () => {
    await tv.goto(BASE + '/obrazovka/');
    await tv.waitForFunction(() => window.__adnaTest.states > 0);
    await s2.click('#btn-next');
    await tv.waitForFunction(() => document.getElementById('callCode').textContent === 'A');
    assert.ok(await tv.locator('#callPoint.left').isVisible(), 'Ambulancia č. 2 → lekárka ukazuje vľavo');
    assert.match(await tv.locator('#tvCallSub').innerText(), /Dvere č. 2 vľavo · MUDr. Czetöová vás čaká/);
    assert.match(await tv.locator('#tvCallCode').getAttribute('class'), /c1/, 'Ambulancia 2 = sivá');
    await sleep(600);
    await tv.screenshot({ path: path.join(SHOTS, 'tv22-vyvolanie-vlavo.png') });
    await s1.click('#btn-next');
    await tv.waitForFunction(() => document.getElementById('callCode').textContent === '1', null, { timeout: 12000 });
    assert.deepEqual(await tv.evaluate(() => window.__adnaTest.shown), ['A', '1'], 'kto vyvolá prvý, ten sa zobrazí prvý');
    await tv.waitForFunction(() => window.__said.length >= 2, null, { timeout: 4000 });
    const said = await tv.evaluate(() => window.__said);
    assert.deepEqual(said.map((x) => x[0]), ['Písmeno á, prosím, môžete vstúpiť do ambulancie číslo dva.', 'Číslo jeden, prosím, môžete vstúpiť do ambulancie číslo jeden.'], 'hlásenie po signáli');
    assert.match(said[0][1], /Viktoria/, 'prirodzený slovenský hlas');
    assert.ok(!(await tv.locator('#voiceWarn').isVisible()));
    assert.equal(await tv.locator('#callRoom').innerText(), 'Ambulancia č. 1');
    assert.match(await tv.locator('#callSub').innerText(), /MUDr. Pavel Staško.*Dvere č. 1 · vpravo/);
    assert.ok(await tv.locator('#callPoint.right').isVisible(), 'Ambulancia č. 1 → lekár ukazuje vpravo');
    assert.ok(await tv.locator('#callDocImg').isVisible(), 'fotka lekára');
    await sleep(600);
    await tv.screenshot({ path: path.join(SHOTS, 'tv22-vyvolanie-vpravo.png') });
    assert.equal(await tv.locator('#roomRows .tile').first().innerText(), 'A', 'druhá ambulancia: práve vyšetruje A');
    const chips = await tv.$$eval('#queueList li', (l) => l.map((li) => [li.querySelector('.c-code').textContent, li.className]));
    assert.match(chips.find((c) => c[0] === 'B')[1], /c1/, 'čísla ambulancie 2 sivým rámom');
    assert.match(chips.find((c) => c[0] === '2')[1], /c0/, 'čísla ambulancie 1 červeným rámom');
  });

  await step('predĺžený výkon: sestra 1 nahlási 1,5 h → oznam a meškanie len pri jej pacientoch', async () => {
    await s1.click('#btn-delay'); await s1.selectOption('#m-min', '90'); await s1.click('#m-ok');
    await s1.waitForFunction(() => /Meškanie 1 h 30 min/.test(document.getElementById('btn-delay').textContent));
    await tv.waitForSelector('#callCard.hidden', { state: 'attached', timeout: 20000 });   // výzva po vyvolaní zmizne
    await tv.waitForFunction((id) => /Čakanie dlhšie o 1 h 30 min/.test((document.querySelector(`#roomRows [data-room="${id}"] .r-late`) || {}).textContent || ''), rooms[0].id, { timeout: 5000 });
    assert.equal(await tv.locator('#roomRows .r-late').count(), 1, 'oznam len pri ambulancii 1');
    const rows = await tv.$$eval('#queueList li', (l) => l.map((li) => [li.querySelector('.c-code').textContent, li.querySelector('.c-delta').textContent]));
    const get = (c) => (rows.find((r) => r[0] === c) || [])[1];
    assert.match(get('2'), /\+1 h 30/, JSON.stringify(rows));
    assert.match(get('3'), /\+1 h 30/);
    assert.doesNotMatch(get('B'), /h/, 'ambulancia 2 nie je ovplyvnená: ' + get('B'));
    await sleep(500);
    await tv.screenshot({ path: path.join(SHOTS, 'tv21-predlzeny-vykon.png') });
    await s1.screenshot({ path: path.join(SHOTS, 'sestra21-hlasenie-meskania.png') });
  });

  await step('ďalšie vyvolanie z ambulancie 1 oznam zruší', async () => {
    await s1.click('#btn-next');
    await tv.waitForFunction(() => document.getElementById('callCode').textContent === '2', null, { timeout: 5000 });
    await tv.waitForSelector('#callCard.hidden', { state: 'attached', timeout: 20000 });
    assert.equal(await tv.locator('#roomRows .r-late').count(), 0);
  });

  await step('mimoriadny oznam: sestra napíše text → TV ho ukáže so signálom, zrušenie ho skryje', async () => {
    const ch0 = await tv.evaluate(() => window.__adnaTest.chimes);
    await s2.click('#btn-announce'); await s2.waitForSelector('#m-ann');
    await s2.click('button[data-ann^="Lekár bol odvolaný"]');
    await s2.screenshot({ path: path.join(SHOTS, 'sestra23-mimoriadny-oznam-okno.png') });
    await s2.click('#m-ok');
    await tv.waitForFunction(() => !document.getElementById('tvAnnounce').classList.contains('hidden'), null, { timeout: 5000 });
    assert.match(await tv.locator('#tvAnnText').innerText(), /odvolaný k akútnemu/);
    assert.ok(await tv.locator('#tickerAnn').isVisible(), 'oznam nahradí lištu správ');
    assert.ok((await tv.evaluate(() => window.__adnaTest.chimes)) > ch0, 'nový oznam zaznie signálom');
    await s1.waitForSelector('[data-act="announce-clear"]');   // vidí ho aj druhá sestra
    await sleep(700);
    await tv.screenshot({ path: path.join(SHOTS, 'tv23-mimoriadny-oznam.png') });
    await s1.screenshot({ path: path.join(SHOTS, 'sestra23-oznam-zapnuty.png') });
    await s1.click('[data-act="announce-clear"]');
    await tv.waitForFunction(() => document.getElementById('tvAnnounce').classList.contains('hidden'), null, { timeout: 5000 });
    assert.ok(!(await tv.locator('#tickerAnn').isVisible()));
  });

  await step('bez chýb JavaScriptu', async () => { assert.deepEqual(errors, []); });
  await b.close(); proc.kill('SIGTERM');
  console.log(`\nVýsledok: ${ok} OK`); process.exit(0);
})().catch((e) => { console.error(e); if (proc) proc.kill('SIGTERM'); process.exit(1); });
