'use strict';
/**
 * Ovládač OSTREJ VRP2 cez oficiálne webové rozhranie Finančnej správy SR (https://vrp2.financnasprava.sk/),
 * deterministicky cez Playwright s vyhradeným profilom prehliadača (prihlásenie zostáva len na tomto počítači).
 *
 * ⚠ STAV: NEOVERENÉ PROTI SKUTOČNEJ VRP2. Pri vývoji nebol k dispozícii prístup do VRP2 AdNa, preto tu NIE SÚ žiadne
 * vymyslené selektory ani interné adresy. Ovládanie sa číta zo súboru vrp2-ovladanie.json, ktorý poverená osoba vyplní
 * počas overovacieho sedenia (docs/POKLADNICA-VRP2.md, časť „Overenie ostrej VRP2“). Kým v ňom nie je "overene": true,
 * ovládač každú operáciu odmietne – agent úlohu zastaví pred vystavením (needs_session / failed), platba ostane zaevidovaná.
 *
 * Čo je overené z oficiálnych zdrojov FS (pozri dokumentáciu): webová VRP2 beží na vrp2.financnasprava.sk, prihlasuje sa
 * menom a heslom (prvé prihlásenie s PIN), po 20 min nečinnosti nasleduje 5-minútové odpočítavanie a odhlásenie; doklad sa
 * vygeneruje ako PDF (formáty A4/A5/A6/58 mm/80 mm) a otvorí v novej karte; VRP2 ponúka tlač kópie dokladu.
 * Agent reláciu nijako „neudržiava pri živote“ a neobchádza prihlásenie – po odhlásení hlási „treba obnoviť prihlásenie“.
 */
const fs = require('node:fs');
const path = require('node:path');
const { SessionExpired, IssueUncertain, PrepareError } = require('./simulator');
const { parseEur } = require('../../../shared/peniaze.js');

const VRP2_URL = 'https://vrp2.financnasprava.sk/';   // zdroj: financnasprava.sk/sk/podnikatelia/dane/ekasa/vrp2

class NotVerified extends Error {
  constructor(what) { super(`Ovládanie VRP2 nie je overené (${what}) – vyplňte a overte vrp2-ovladanie.json. Doklad sa nevystavil.`); this.code = 'PREPARE'; }
}

class Vrp2WebDriver {
  /** @param {{profil:string, ovladanie:string, url?:string, headless?:boolean}} cfg */
  constructor(cfg) {
    this.mode = 'live';
    this.cfg = cfg;
    this.ov = null;
    try { this.ov = JSON.parse(fs.readFileSync(cfg.ovladanie, 'utf8')); } catch { this.ov = null; }
    this.ctx = null; this.page = null; this.draftReady = false;
  }

  verified() { return !!(this.ov && this.ov.overene === true && this.ov.selektory); }
  sel(k) {
    if (!this.verified()) throw new NotVerified('chýba "overene": true');
    const s = this.ov.selektory[k];
    if (!s) throw new NotVerified(`chýba selektor „${k}“`);
    return s;
  }

  async open() {
    if (this.page && !this.page.isClosed()) return this.page;
    let pw;
    try { pw = require('playwright'); } catch { throw new PrepareError('Chýba knižnica Playwright (npm install v priečinku agent).'); }
    fs.mkdirSync(this.cfg.profil, { recursive: true });
    this.ctx = await pw.chromium.launchPersistentContext(this.cfg.profil, { headless: this.cfg.headless !== false, acceptDownloads: true, locale: 'sk-SK' });
    this.page = this.ctx.pages()[0] || await this.ctx.newPage();
    await this.page.goto(this.cfg.url || VRP2_URL, { waitUntil: 'domcontentloaded' });
    return this.page;
  }
  async close() { try { await this.ctx?.close(); } catch {} this.ctx = null; this.page = null; }

  async sessionState() {
    if (!this.verified()) return 'unknown';
    try {
      const pg = await this.open();
      if (await pg.locator(this.sel('prihlasovaciFormular')).count()) return 'login_required';
      return (await pg.locator(this.sel('prihlaseny')).count()) ? 'ok' : 'unknown';
    } catch { return 'unknown'; }
  }

  async text(k) { return (await this.page.locator(this.sel(k)).first().innerText({ timeout: 5000 })).trim(); }

  async activeRegister() {
    if ((await this.sessionState()) !== 'ok') throw new SessionExpired();
    return { code: await this.text('kodPokladnice'), companyName: await this.text('nazovSpolocnosti'), companyIco: this.ov.selektory.ico ? await this.text('ico') : null };
  }

  /** Položky sa vyhľadajú v katalógu VRP2 podľa presného názvu; cena je prednastavená v katalógu (agent ju neprepisuje). */
  async prepare(job) {
    const pg = this.page || await this.open();
    if ((await this.sessionState()) !== 'ok') throw new SessionExpired();
    await pg.locator(this.sel('novyDoklad')).click();
    for (const it of job.items) {
      await pg.locator(this.sel('hladatPolozku')).fill(it.name);
      const hit = pg.locator(this.sel('vysledokPolozky'), { hasText: it.name });
      if ((await hit.count()) !== 1) throw new PrepareError(`Položka „${it.name}“ sa v katalógu VRP2 nenašla jednoznačne.`);
      await hit.click();
      await pg.locator(this.sel('mnozstvo')).fill(String(it.qty));
      await pg.locator(this.sel('pridatPolozku')).click();
    }
    await pg.locator(this.sel(job.method === 'cash' ? 'platidloHotovost' : 'platidloKarta')).click();
    if (job.method === 'cash' && this.ov.selektory.prijataSuma) await pg.locator(this.sel('prijataSuma')).fill((job.receivedCents / 100).toFixed(2).replace('.', ','));
    this.draftReady = true;
  }

  async readDraft() {
    const pg = this.page;
    const rows = pg.locator(this.sel('riadokKonceptu'));
    const n = await rows.count();
    const items = [];
    const cents = (s) => parseEur(String(s).replace(/[^\d,.-]/g, ''));
    for (let i = 0; i < n; i++) {
      const r = rows.nth(i);
      const t = async (k) => (await r.locator(this.sel(k)).first().innerText()).trim();
      items.push({ name: await t('riadokNazov'), qty: Number((await t('riadokMnozstvo')).replace(',', '.')), unitCents: cents(await t('riadokJednotkovaCena')), totalCents: cents(await t('riadokSuma')) });
    }
    const act = await this.activeRegister();
    return { registerCode: act.code, companyName: act.companyName, companyIco: act.companyIco, items,
      totalCents: cents(await this.text('sumaSpolu')), roundingCents: this.ov.selektory.zaokruhlenie ? cents(await this.text('zaokruhlenie')) || 0 : 0,
      payableCents: cents(await this.text('sumaNaUhradu')),
      method: (await pg.locator(this.sel('platidloHotovostVybrane')).count()) ? 'cash' : (await pg.locator(this.sel('platidloKartaVybrane')).count()) ? 'card' : null };
  }

  async discardDraft() { if (this.draftReady && this.verified() && this.ov.selektory.zrusitKoncept) await this.page.locator(this.sel('zrusitKoncept')).click().catch(() => {}); this.draftReady = false; }

  /**
   * Konečné vystavenie + prevzatie originálneho PDF (VRP2 ho otvára v novej karte). Akákoľvek neistota → IssueUncertain.
   */
  async issue() {
    const pg = this.page;
    const popup = pg.context().waitForEvent('page', { timeout: 30_000 }).catch(() => null);
    try { await pg.locator(this.sel('vystavit')).click({ timeout: 10_000 }); }
    catch (e) { throw new IssueUncertain(`Kliknutie na vystavenie neprebehlo jednoznačne: ${e.message}`); }
    let id, number;
    try {
      await pg.locator(this.sel('vystavenyDoklad')).waitFor({ timeout: 30_000 });
      id = await this.text('idDokladu');
      number = this.ov.selektory.poradoveCislo ? await this.text('poradoveCislo') : null;
    } catch (e) { throw new IssueUncertain(`VRP2 nepotvrdila vydanie dokladu: ${e.message}`); }
    if (!id) throw new IssueUncertain('VRP2 nezobrazila ID dokladu.');
    const act = await this.activeRegister().catch(() => ({}));
    const payable = this.ov.selektory.vystavenaSuma ? parseEur((await this.text('vystavenaSuma')).replace(/[^\d,.-]/g, '')) : null;
    let output = null;
    const p2 = await popup;
    if (p2) {
      const resp = await p2.waitForResponse((r) => /application\/pdf/i.test(r.headers()['content-type'] || ''), { timeout: 30_000 }).catch(() => null);
      if (resp) output = { ext: 'pdf', data: await resp.body() };
      await p2.close().catch(() => {});
    }
    this.draftReady = false;
    return { id, number, issuedAt: new Date().toISOString(), registerCode: act.code, payableCents: payable, simulated: false, output };
  }

  /** Overenie po výpadku. Spoľahlivé párovanie (nie podľa sumy a času) zatiaľ nie je overené → reliable: false. */
  async findIssued() { return { reliable: false, receipt: null }; }

  /** Kópia dokladu cez „Zoznam vystavených dokladov“ VRP2 – vyžaduje overené selektory. */
  async copyOutput(receipt) {
    const pg = this.page || await this.open();
    if ((await this.sessionState()) !== 'ok') throw new SessionExpired();
    await pg.locator(this.sel('zoznamDokladov')).click();
    await pg.locator(this.sel('hladatDoklad')).fill(String(receipt.number || receipt.id));
    const row = pg.locator(this.sel('riadokDokladu'), { hasText: String(receipt.id) });
    if ((await row.count()) !== 1) throw new PrepareError(`Doklad ${receipt.id} sa v zozname VRP2 nenašiel jednoznačne.`);
    const popup = pg.context().waitForEvent('page', { timeout: 30_000 });
    await row.locator(this.sel('tlacitKopiu')).click();
    const p2 = await popup;
    const resp = await p2.waitForResponse((r) => /application\/pdf/i.test(r.headers()['content-type'] || ''), { timeout: 30_000 });
    const data = await resp.body();
    await p2.close().catch(() => {});
    return { ext: 'pdf', data };
  }

  /** Prvotné / výnimočné prihlásenie: viditeľné okno, prihlási sa poverená osoba sama (meno, heslo, PIN). */
  static async interactiveLogin(cfg) {
    const pw = require('playwright');
    fs.mkdirSync(cfg.profil, { recursive: true });
    const ctx = await pw.chromium.launchPersistentContext(cfg.profil, { headless: false, locale: 'sk-SK', viewport: null });
    const pg = ctx.pages()[0] || await ctx.newPage();
    await pg.goto(cfg.url || VRP2_URL);
    console.log('\n  Prihláste sa do VRP2 v otvorenom okne (meno, heslo). Skontrolujte, že je vybraná správna pokladnica.\n  Potom okno zatvorte.\n');
    await new Promise((r) => ctx.on('close', r));
  }
}

module.exports = { Vrp2WebDriver, NotVerified, VRP2_URL };
// cesta k vzoru ovládania (vyplní poverená osoba): agent/vrp2-ovladanie.vzor.json
module.exports.VZOR = path.join(__dirname, '..', '..', 'vrp2-ovladanie.vzor.json');
