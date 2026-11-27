'use strict';
/**
 * Jadro lokálneho agenta VRP2. Úlohy spracúva postupne (jedna naraz → pre jednu pokladnicu vždy postupne).
 * O cene, platbe ani úspechu vystavenia nerozhoduje jazykový model – len pevné porovnanie údajov (porovnanie.js)
 * a výsledok, ktorý vráti VRP2.
 *
 * Postup pre úlohu „issue“ (zadanie Pali, bod 5):
 *  1. relácia VRP2 → inak needs_session (nič sa neodoslalo)
 *  2. aktívna pokladnica = pokladnica z platby (kód, IČO) → inak mismatch
 *  3. príprava položiek a platidla vo VRP2
 *  4. porovnanie konceptu s potvrdenou platbou → pri rozdiele mismatch s konkrétnou nezhodou, bez vystavenia
 *  5. server potvrdí „submitting“ → denník „clicking“ → vystavenie → výsledok potvrdený VRP2
 *  6. originálny výstup sa uloží lokálne; tlač príde ako samostatná úloha zo servera
 *  7. výsledok → server (pri výpadku sa nahlási po reštarte z denníka)
 */
const { compareDraft } = require('./porovnanie');
const { testPage } = require('./pdf');

class Agent {
  constructor({ api, driver, printer, journal, name = 'agent', log = () => {}, version = '1.0.0' }) {
    Object.assign(this, { api, driver, printer, journal, name, log, version });
    this.printerState = null;
    this.session = 'unknown';
    this.stopped = false;
  }

  async heartbeat() {
    try { this.session = await this.driver.sessionState(); } catch { this.session = 'unknown'; }
    let reg = null;
    try { if (this.session === 'ok') reg = (await this.driver.activeRegister()).code; } catch {}
    const regs = this.registers || [];
    this.printerState = await this.printer.check(regs[0] && regs[0].printerName);
    const r = await this.api.post('/api/agent/heartbeat', { mode: this.driver.mode, session: this.session, activeRegisterCode: reg, printer: this.printerState, version: this.version });
    this.registers = r.registers || [];
    return r;
  }

  /** Jedno kolo: vypýta si úlohu a spracuje ju. Vráti typ spracovanej úlohy alebo null. */
  async runOnce() {
    const { job } = await this.api.post('/api/agent/claim', { mode: this.driver.mode, session: this.session });
    if (!job) return null;
    if (job.type === 'print') await this.doPrint(job);
    else if (job.type === 'verify') await this.doVerify(job.payment);
    else if (job.type === 'issue') await this.doIssue(job.payment);
    return job.type;
  }

  async result(p, body) {
    return this.api.post(`/api/agent/payments/${p.paymentId}/result`, { claimToken: p.claimToken, ...body }, { retries: 3 });
  }

  async doIssue(p) {
    const j = this.journal;
    j.write(p.paymentId, p.attempt, 'claimed');
    // 1. relácia
    if ((await this.driver.sessionState()) !== 'ok') {
      this.session = 'login_required';
      j.write(p.paymentId, p.attempt, 'stopped', { outcome: 'needs_session' });
      return this.result(p, { outcome: 'needs_session', detail: 'VRP2 vyžaduje prihlásenie – nič sa neodoslalo.' });
    }
    try {
      // 2. správna pokladnica
      const act = await this.driver.activeRegister();
      const wrong = [];
      if (act.code !== p.register.vrpCode) wrong.push(`Vo VRP2 je aktívna pokladnica „${act.code || '?'}“, platba patrí pokladnici „${p.register.vrpCode}“ (${p.company.name}).`);
      if (p.company.ico && act.companyIco != null && String(act.companyIco) !== String(p.company.ico)) wrong.push(`Aktívna pokladnica patrí IČO ${act.companyIco}, platba spoločnosti ${p.company.name} (IČO ${p.company.ico}).`);
      if (wrong.length) { j.write(p.paymentId, p.attempt, 'stopped', { outcome: 'mismatch' }); return this.result(p, { outcome: 'mismatch', detail: wrong.join(' ') }); }
      // 3. položky a platidlo
      await this.driver.prepare(p);
      // 4. porovnanie
      const diffs = compareDraft(p, await this.driver.readDraft());
      if (diffs.length) {
        await this.driver.discardDraft().catch(() => {});
        j.write(p.paymentId, p.attempt, 'stopped', { outcome: 'mismatch' });
        return this.result(p, { outcome: 'mismatch', detail: diffs.join(' ') });
      }
    } catch (e) {
      await this.driver.discardDraft().catch(() => {});
      const outcome = e.code === 'SESSION' ? 'needs_session' : e.code === 'PREPARE' ? 'mismatch' : 'failed';
      if (outcome === 'needs_session') this.session = 'login_required';
      j.write(p.paymentId, p.attempt, 'stopped', { outcome });
      return this.result(p, { outcome, detail: `${e.message} (nič sa neodoslalo)` });
    }
    // 5. trvalý záznam pred odoslaním – bez potvrdenia servera sa nevystavuje
    try {
      await this.api.post(`/api/agent/payments/${p.paymentId}/submitting`, { claimToken: p.claimToken, attempt: p.attempt });
    } catch (e) {
      await this.driver.discardDraft().catch(() => {});
      j.write(p.paymentId, p.attempt, 'stopped', { outcome: 'no_ack' });
      this.log('warn', 'Server nepotvrdil začiatok odoslania – doklad sa nevystavil', { payment: p.paymentId, err: e.message });
      return null;
    }
    j.write(p.paymentId, p.attempt, 'ack');        // server potvrdil „submitting“ tomuto procesu
    j.write(p.paymentId, p.attempt, 'clicking');   // od tohto riadku VRP2 mohla doklad vydať
    let rec;
    try {
      rec = await this.driver.issue();
    } catch (e) {
      if (e.code === 'CRASH') throw e;   // simulovaný pád agenta (testy)
      j.write(p.paymentId, p.attempt, 'uncertain', { err: e.message.slice(0, 200) });
      return this.result(p, { outcome: 'unverified', detail: `Výsledok vystavenia nie je istý: ${e.message}` });
    }
    // 6.–7.
    if (rec.output) j.saveOutput(p.paymentId, rec.output);
    const receipt = { id: rec.id, number: rec.number, issuedAt: rec.issuedAt, registerCode: rec.registerCode, payableCents: rec.payableCents, simulated: !!rec.simulated };
    j.write(p.paymentId, p.attempt, 'issued', { receipt });
    return this.result(p, { outcome: 'issued', receipt });
  }

  /** Po reštarte: úloha, pri ktorej sa začalo odoslanie. Nikdy nevystaví nový doklad. */
  async doVerify(p) {
    const steps = this.journal.steps(p.paymentId, p.attempt);
    const last = (s) => steps.filter((x) => x.step === s).pop();
    const issued = last('issued');
    if (issued) return this.result(p, { outcome: 'issued', receipt: issued.receipt, verified: 'dennik' });
    if (last('ack') && !last('clicking')) {
      // tento agent sám dostal potvrdenie servera a preukázateľne neklikol na vystavenie (pád medzi dvomi zápismi denníka).
      // Bez vlastného záznamu „ack“ (napr. úlohu rozpracoval iný proces) sa nič nepredpokladá → overenie / poverená osoba.
      return this.result(p, { outcome: 'not_submitted', detail: 'Podľa denníka agenta sa vystavenie nespustilo.' });
    }
    try {
      const f = await this.driver.findIssued(p);
      if (f.reliable && f.receipt) {
        const r = f.receipt;
        if (r.payableCents !== p.payableCents) return this.result(p, { outcome: 'unverified', detail: `Vo VRP2 je doklad ${r.id} s inou sumou – treba kontrolu.` });
        const receipt = { id: r.id, number: r.number, issuedAt: r.issuedAt, registerCode: r.registerCode, payableCents: r.payableCents, simulated: !!r.simulated };
        this.journal.write(p.paymentId, p.attempt, 'issued', { receipt, verified: true });
        return this.result(p, { outcome: 'issued', receipt, verified: 'vrp2' });
      }
      if (f.reliable && !f.receipt && last('clicking')) {
        return this.result(p, { outcome: 'unverified', detail: 'Doklad sa v evidencii VRP2 nenašiel, ale vystavenie sa spustilo – overí poverená osoba.' });
      }
    } catch (e) { this.log('warn', 'Overenie dokladu vo VRP2 zlyhalo', { payment: p.paymentId, err: e.message }); }
    return this.result(p, { outcome: 'unverified', detail: 'Spojenie sa prerušilo počas vystavenia a doklad nemožno jednoznačne spárovať – overí poverená osoba.' });
  }

  async doPrint(job) {
    const pr = job.print;
    const report = (status, message) => this.api.post(`/api/agent/print-jobs/${pr.jobId}/result`, { claimToken: pr.claimToken, status, message }, { retries: 3 });
    try {
      let pdf;
      if (pr.kind === 'test') pdf = testPage({ agentName: this.name, printerName: pr.printerName, registerLabel: pr.registerLabel, companyName: pr.companyName, widthMm: this.printer.cfg.sirkaMm });
      else {
        const p = job.payment;
        let out = pr.kind === 'original' ? this.journal.loadOutput(p.paymentId) : null;
        // kópia (alebo originál, ktorý vystavil iný počítač): postup pre kópiu dokladu, ktorý ponúka VRP2
        if (!out) out = await this.driver.copyOutput(p.receipt);
        pdf = out.data;
      }
      const r = await this.printer.print(pdf, pr.printerName, pr.kind === 'test' ? 'skusobna-tlac' : `doklad-${job.payment.paymentId}-${pr.kind}`);
      return report(r.status, r.message);
    } catch (e) {
      return report('failed', String(e.message).slice(0, 200));
    }
  }

  async loop({ pollMs = 2000, heartbeatMs = 5000 } = {}) {
    let lastHb = 0;
    while (!this.stopped) {
      try {
        if (Date.now() - lastHb > heartbeatMs) { await this.heartbeat(); lastHb = Date.now(); }
        const t = await this.runOnce();
        if (t) { lastHb = 0; continue; }
      } catch (e) {
        if (e.code === 'CRASH') throw e;
        this.log('warn', 'Chyba v cykle agenta', { err: String(e.message).slice(0, 300) });
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  stop() { this.stopped = true; }
}

/** Klient servera AdNa. Token sa nikdy nezapisuje do logov. */
function serverApi(base, token, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  async function post(p, body, { retries = 0 } = {}) {
    for (let i = 0; ; i++) {
      try {
        const res = await fetchImpl(base.replace(/\/$/, '') + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body || {}), signal: AbortSignal.timeout(timeoutMs) });
        let data = null; try { data = await res.json(); } catch {}
        if (!res.ok) { const e = new Error((data && data.error && data.error.message) || `HTTP ${res.status}`); e.status = res.status; throw e; }
        return data;
      } catch (e) {
        if (i >= retries || (e.status && e.status < 500)) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
      }
    }
  }
  return { post };
}

module.exports = { Agent, serverApi };
