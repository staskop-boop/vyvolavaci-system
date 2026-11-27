'use strict';
/**
 * SIMULÁTOR VRP2 – len na vývoj a automatické testy. Nikdy nekomunikuje s Finančnou správou a nikdy nevydá daňový doklad.
 * Každý simulovaný doklad má ID „SIM-…“, príznak simulated: true a na výtlačku nápis „SIMULÁCIA – NIE JE POKLADNIČNÝ DOKLAD“.
 *
 * Správa sa podobne ako VRP2 (podľa príručky FS): pokladnica patrí spoločnosti (IČO), položky majú v katalógu prednastavenú
 * cenu, hotovosť sa zaokrúhľuje na 5 centov, karta nie, vydaný doklad má ID a poradové číslo, dá sa vytlačiť kópia.
 * Stav sa ukladá do súboru, aby prežil „reštart agenta“ v testoch. Chyby sa dajú vyvolať (faults) – pozri testy.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const money = require('../../../shared/peniaze.js');
const { textPdf } = require('../pdf');

class SessionExpired extends Error { constructor(m = 'Relácia VRP2 vypršala – treba sa prihlásiť.') { super(m); this.code = 'SESSION'; } }
class IssueUncertain extends Error { constructor(m) { super(m); this.code = 'UNCERTAIN'; } }
class PrepareError extends Error { constructor(m) { super(m); this.code = 'PREPARE'; } }

class Vrp2Simulator {
  /** @param {string|null} file  súbor so stavom (null = len v pamäti) */
  constructor(file, init = {}) {
    this.file = file;
    const def = { registers: [], activeCode: null, session: 'ok', catalog: {}, issued: [], seq: 0, faults: {} };
    let st = null;
    if (file) { try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { st = null; } }
    this.st = st || { ...def, ...init };
    this.draft = null;
    this.save();
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.st, null, 1));
    fs.renameSync(this.file + '.tmp', this.file);
  }
  reload() { if (this.file) { try { this.st = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {} } }
  set(patch) { this.reload(); Object.assign(this.st, patch); this.save(); }
  fault(name, v = true) { this.reload(); this.st.faults[name] = v; this.save(); }
  issuedList() { this.reload(); return this.st.issued; }
}

/** Ovládač so simulátorom – rovnaké rozhranie ako ovládač ostrej VRP2 (vrp2-web.js). */
class SimDriver {
  constructor(sim) { this.sim = sim; this.mode = 'sim'; this.draft = null; }

  async sessionState() { this.sim.reload(); return this.sim.st.session === 'ok' ? 'ok' : 'login_required'; }

  async activeRegister() {
    this.sim.reload();
    if (this.sim.st.session !== 'ok') throw new SessionExpired();
    const r = this.sim.st.registers.find((x) => x.code === this.sim.st.activeCode);
    return r ? { code: r.code, companyName: r.companyName, companyIco: r.ico, workplace: r.workplace || '' } : { code: null };
  }

  async prepare(job) {
    this.sim.reload();
    const f = this.sim.st.faults;
    if (this.sim.st.session !== 'ok' || f.sessionExpiresOnPrepare) { if (f.sessionExpiresOnPrepare) this.sim.set({ session: 'expired' }); throw new SessionExpired(); }
    const reg = this.sim.st.registers.find((x) => x.code === this.sim.st.activeCode);
    // bez zadaného katalógu simulátor prevezme názvy a ceny z úlohy (skúšobná prevádzka); testy katalóg zadávajú
    const cat = this.sim.st.catalog[this.sim.st.activeCode];
    const items = [];
    for (const it of job.items) {
      const c = cat ? cat.find((x) => x.name === it.name) : { name: it.name, priceCents: it.unitCents };
      if (!c) throw new PrepareError(`Položka „${it.name}“ v katalógu tovarov a služieb VRP2 neexistuje.`);
      if (f.dropItem === it.name) continue;
      const qty = f.qtyOverride && f.qtyOverride[it.name] ? f.qtyOverride[it.name] : it.qty;
      items.push({ name: c.name, qty, unitCents: c.priceCents, totalCents: c.priceCents * qty });
    }
    const total = items.reduce((a, i) => a + i.totalCents, 0);
    const rounding = job.method === 'cash' ? money.cashRounding(total) : 0;
    this.draft = { registerCode: reg && reg.code, companyName: reg && reg.companyName, companyIco: reg && reg.ico, items, totalCents: total, roundingCents: rounding,
      payableCents: total + rounding, method: f.methodOverride || job.method, receivedCents: job.method === 'cash' ? job.receivedCents : null, reference: job.opId };
  }

  async readDraft() { return this.draft ? structuredClone(this.draft) : null; }
  async discardDraft() { this.draft = null; }

  /** Konečné vystavenie. Chyby simulujú výpadok spojenia PRED a PO vydaní dokladu. */
  async issue() {
    this.sim.reload();
    const f = this.sim.st.faults;
    if (!this.draft) throw new PrepareError('Nie je pripravený koncept dokladu.');
    if (f.failBeforeIssue) throw new IssueUncertain('Spojenie s VRP2 sa prerušilo počas odosielania.');
    this.sim.st.seq += 1;
    const d = this.draft;
    const rec = { id: 'SIM-' + crypto.randomBytes(6).toString('hex').toUpperCase(), number: String(this.sim.st.seq), registerCode: d.registerCode,
      issuedAt: new Date().toISOString(), items: d.items, totalCents: d.totalCents, roundingCents: d.roundingCents, payableCents: d.payableCents, method: d.method,
      reference: d.reference, simulated: true };
    this.sim.st.issued.push(rec);
    this.sim.save();
    this.draft = null;
    if (f.crashAfterIssue) { this.sim.fault('crashAfterIssue', false); const e = new Error('SIMULOVANÝ PÁD AGENTA po vydaní dokladu'); e.code = 'CRASH'; throw e; }
    if (f.uncertainAfterIssue) { this.sim.fault('uncertainAfterIssue', false); throw new IssueUncertain('Odpoveď VRP2 neprišla (doklad mohol byť vydaný).'); }
    return { ...rec, output: { ext: 'pdf', data: this.render(rec, false) } };
  }

  /**
   * Overenie po výpadku. Simulátor vie doklad spoľahlivo nájsť podľa referencie operácie (op_id) – to je predpoklad,
   * ktorý v skutočnej VRP2 overený NIE JE (pozri docs/POKLADNICA-VRP2.md). reliable: false = overenie nie je k dispozícii.
   */
  async findIssued(job) {
    this.sim.reload();
    if (this.sim.st.faults.noReliableLookup) return { reliable: false, receipt: null };
    const r = this.sim.st.issued.find((x) => x.reference === job.opId);
    return { reliable: true, receipt: r ? { ...r } : null };
  }

  async copyOutput(receipt) {
    this.sim.reload();
    const r = this.sim.st.issued.find((x) => x.id === receipt.id);
    if (!r) throw new PrepareError('Doklad sa vo VRP2 (simulátor) nenašiel.');
    return { ext: 'pdf', data: this.render(r, true) };
  }

  render(r, copy) {
    const L = [
      { text: 'SIMULÁCIA – NIE JE POKLADNIČNÝ DOKLAD', size: 10, bold: true },
      { text: 'nefiskalizované, testovací režim AdNa', size: 8 },
      { text: copy ? 'KÓPIA' : ' ', size: 9, bold: true },
      { text: `Pokladnica ${r.registerCode}` , size: 8 },
      { text: `Doklad č. ${r.number} · ID ${r.id}`, size: 8 },
      { text: new Date(r.issuedAt).toLocaleString('sk-SK', { timeZone: 'Europe/Bratislava' }), size: 8 },
      { text: '------------------------------------------', size: 8 },
    ];
    for (const i of r.items) L.push({ text: `${i.name}`, size: 8 }, { text: `   ${i.qty} x ${money.fmtEur(i.unitCents)} = ${money.fmtEur(i.totalCents)}`, size: 8 });
    L.push({ text: '------------------------------------------', size: 8 }, { text: `Spolu ${money.fmtEur(r.totalCents)}`, size: 9 });
    if (r.roundingCents) L.push({ text: `Zaokrúhlenie ${money.fmtEur(r.roundingCents)}`, size: 8 });
    L.push({ text: `Na úhradu ${money.fmtEur(r.payableCents)} (${r.method === 'cash' ? 'hotovosť' : 'karta'})`, size: 10, bold: true },
      { text: copy ? 'QR kód: (kópia – bez QR)' : 'QR kód: (simulácia – bez QR)', size: 8 }, { text: 'SIMULÁCIA', size: 12, bold: true });
    return textPdf(L);
  }
}

module.exports = { Vrp2Simulator, SimDriver, SessionExpired, IssueUncertain, PrepareError };
