'use strict';
/**
 * Porovnanie konceptu dokladu vo VRP2 s platbou potvrdenou v AdNa – PRED konečným vystavením.
 * Akýkoľvek rozdiel = zastaviť a uviesť konkrétnu nezhodu. Žiadne „približne“, žiadny jazykový model.
 */
const { fmtEur } = require('../../shared/peniaze.js');

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * @param job    úloha zo servera (items, method, totalCents, roundingCents, payableCents, receivedCents, register, company)
 * @param draft  stav vo VRP2 { registerCode, companyName, companyIco, items:[{name, qty, unitCents, totalCents}], totalCents, roundingCents, payableCents, method }
 * @returns {string[]} zoznam nezhôd (prázdny = súhlasí)
 */
function compareDraft(job, draft) {
  const diffs = [];
  if (!draft || typeof draft !== 'object') return ['VRP2 nevrátila koncept dokladu.'];
  if (norm(draft.registerCode) !== norm(job.register.vrpCode)) diffs.push(`Aktívna pokladnica VRP2 je „${norm(draft.registerCode) || '?'}“, platba patrí pokladnici „${job.register.vrpCode}“.`);
  if (job.company.ico && draft.companyIco != null && norm(draft.companyIco) !== norm(job.company.ico)) diffs.push(`IČO vo VRP2 je ${norm(draft.companyIco) || '?'}, platba patrí spoločnosti ${job.company.name} (IČO ${job.company.ico}).`);
  const di = Array.isArray(draft.items) ? draft.items : [];
  if (di.length !== job.items.length) diffs.push(`Počet položiek vo VRP2 je ${di.length}, potvrdených bolo ${job.items.length}.`);
  job.items.forEach((it, i) => {
    const d = di[i];
    if (!d) { diffs.push(`Položka ${i + 1} „${it.name}“ vo VRP2 chýba.`); return; }
    if (norm(d.name) !== norm(it.name)) diffs.push(`Položka ${i + 1}: vo VRP2 „${norm(d.name)}“, potvrdená „${it.name}“.`);
    if (d.qty !== it.qty) diffs.push(`Položka ${i + 1} „${it.name}“: množstvo vo VRP2 ${d.qty}, potvrdené ${it.qty}.`);
    if (d.unitCents !== it.unitCents) diffs.push(`Položka ${i + 1} „${it.name}“: jednotková cena vo VRP2 ${fmtEur(d.unitCents)}, potvrdená ${fmtEur(it.unitCents)}.`);
    if (d.totalCents !== it.totalCents) diffs.push(`Položka ${i + 1} „${it.name}“: suma vo VRP2 ${fmtEur(d.totalCents)}, potvrdená ${fmtEur(it.totalCents)}.`);
  });
  if (draft.totalCents !== job.totalCents) diffs.push(`Celková suma vo VRP2 ${fmtEur(draft.totalCents)}, potvrdená ${fmtEur(job.totalCents)}.`);
  if ((draft.roundingCents || 0) !== job.roundingCents) diffs.push(`Zaokrúhlenie vo VRP2 ${fmtEur(draft.roundingCents || 0)}, potvrdené ${fmtEur(job.roundingCents)}.`);
  if (draft.payableCents !== job.payableCents) diffs.push(`Suma na úhradu vo VRP2 ${fmtEur(draft.payableCents)}, potvrdená ${fmtEur(job.payableCents)}.`);
  if (draft.method !== job.method) diffs.push(`Platidlo vo VRP2 „${draft.method === 'card' ? 'karta' : draft.method === 'cash' ? 'hotovosť' : draft.method || '?'}“, potvrdené „${job.method === 'card' ? 'karta' : 'hotovosť'}“.`);
  if (job.method === 'cash' && draft.receivedCents != null && draft.receivedCents !== job.receivedCents) diffs.push(`Prijatá hotovosť vo VRP2 ${fmtEur(draft.receivedCents)}, potvrdená ${fmtEur(job.receivedCents)}.`);
  return diffs;
}

module.exports = { compareDraft };
