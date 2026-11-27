// Výpočty súm v celých centoch – spoločné pre server, aplikáciu Sestra aj lokálneho agenta VRP2.
// Nikdy nepracujeme s desatinnými číslami eur, iba s celými centami (Number.isSafeInteger).
// Načítanie: v prehliadači <script src="/shared/peniaze.js"> → window.AdNaPeniaze, v Node.js require('…/shared/peniaze.js').
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AdNaPeniaze = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_CENTS = 10_000_000;   // 100 000 € – vyššia suma na jednom doklade je takmer určite preklep

  function isCents(v) { return Number.isSafeInteger(v) && v >= 0 && v <= MAX_CENTS; }

  /** „12,50“ / „12.5“ / „12“ → 1250 centov; neplatné → null. Bez desatinnej aritmetiky. */
  function parseEur(v) {
    if (typeof v === 'number') v = String(v);
    const s = String(v ?? '').trim().replace(/\s|€/g, '').replace(',', '.');
    const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(s);
    if (!m) return null;
    const c = Number(m[1]) * 100 + Number(((m[2] || '') + '00').slice(0, 2));
    return isCents(c) ? c : null;
  }

  /** 1250 → „12,50 €“ */
  function fmtEur(c) {
    if (!Number.isSafeInteger(c)) return '–';
    const neg = c < 0; const a = Math.abs(c);
    const e = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `${neg ? '−' : ''}${e},${String(a % 100).padStart(2, '0')} €`;
  }

  /**
   * Zaokrúhlenie hotovostnej platby na 5 centov (SR, novela zákona o cenách č. 457/2022 Z. z., od 1. 7. 2022):
   * zaokrúhľuje sa celková suma nákupu platená v hotovosti, nie jednotlivé položky; bezhotovostná platba sa nezaokrúhľuje.
   * Posledná číslica centov: 1, 2 → 0 · 3, 4 → 5 · 6, 7 → 5 · 8, 9 → 10. Výnimka: nákup za 1 alebo 2 centy sa zaokrúhli na 5 centov.
   * Poistka: agent pred vystavením porovná zaokrúhlenie a sumu na úhradu s tým, čo ukáže VRP2 – pri rozdiele doklad nevystaví.
   * @returns {number} rozdiel v centoch (záporný = nadol), napr. 1468 → +2 (14,70 €)
   */
  function cashRounding(totalCents) {
    if (!isCents(totalCents)) throw new Error('Neplatná suma.');
    if (totalCents === 1 || totalCents === 2) return 5 - totalCents;
    const r = totalCents % 5;
    return r === 0 ? 0 : r <= 2 ? -r : 5 - r;
  }

  /**
   * Prepočet dokladu. lines: [{ unitCents, qty }] – qty je celé číslo 1 – 9999 (napr. počet impulzov).
   * @returns {{ totalCents, roundingCents, payableCents, changeCents|null, enough }}
   */
  function compute(lines, method, receivedCents) {
    if (!Array.isArray(lines) || !lines.length) throw new Error('Doklad nemá žiadnu položku.');
    let total = 0;
    for (const l of lines) {
      if (!isCents(l.unitCents) || !Number.isInteger(l.qty) || l.qty < 1 || l.qty > 9999) throw new Error('Neplatná položka dokladu.');
      total += l.unitCents * l.qty;
      if (!isCents(total)) throw new Error('Suma dokladu je príliš vysoká.');
    }
    const rounding = method === 'cash' ? cashRounding(total) : 0;
    const payable = total + rounding;
    let change = null, enough = method !== 'cash';
    if (method === 'cash' && receivedCents != null) {
      enough = isCents(receivedCents) && receivedCents >= payable;
      change = enough ? receivedCents - payable : null;
    }
    return { totalCents: total, roundingCents: rounding, payableCents: payable, changeCents: change, enough };
  }

  return { MAX_CENTS, isCents, parseEur, fmtEur, cashRounding, compute };
}));
