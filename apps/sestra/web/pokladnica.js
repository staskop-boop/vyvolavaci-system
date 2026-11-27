// AdNa Sestra – platba pacienta a pokladničný doklad VRP2 (2026-11-27, Pali).
// Formulár „Ukončiť pacienta“, zoznam „Doklady na doriešenie“ a nastavenia pokladníc. Bez závislostí.
// Sumy sa počítajú v centoch (shared/peniaze.js); rozhodujúci výpočet robí vždy server.
(function () {
  'use strict';
  const { api, esc, fmtTime, fmtDateTime } = window.AdNa;
  const M = window.AdNaPeniaze;
  const eur = M.fmtEur;
  const METHOD = { cash: 'hotovosť', card: 'karta' };

  function newOpId() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);   // funguje aj cez http:// v LAN (crypto.randomUUID vyžaduje https)
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  const simBadge = (sim) => (sim ? '<span class="pay-sim" title="Skúšobný režim – doklad nie je fiskalizovaný">SIMULÁCIA</span>' : '');

  /** Krátky stav platby pri návšteve (zoznam ukončených, história). */
  function payLine(p) {
    if (!p) return '';
    const cls = p.status.attention ? 'pay-line warn' : p.status.issued ? 'pay-line ok' : 'pay-line';
    return `<div class="${cls}" data-pay="${p.id}">${p.status.attention ? '⚠ ' : ''}${esc(p.status.text)}
      <span class="pay-sum">${esc(eur(p.payableCents))} · ${METHOD[p.method]}${p.receiptId ? ` · ID ${esc(p.receiptId)}` : ''}</span></div>`;
  }

  // ---------- formulár „Ukončiť pacienta“ ----------
  /**
   * @returns Promise<'done'|'paid'|null>
   */
  function finishDialog(t, ctx) {
    return new Promise((resolve) => {
      const root = document.getElementById('modal-root');
      root.innerHTML = `<div class="modal-back"><div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="m-title" id="fin">
        <h2 id="m-title">Ukončiť pacienta ${esc(t.code)}</h2><div class="m-body"><div class="center-msg">Načítava sa…</div></div></div></div>`;
      const box = root.querySelector('#fin .m-body');
      let closed = false;
      const close = (v) => { if (closed) return; closed = true; root.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape' && !st.sending) close(null); };
      document.addEventListener('keydown', onKey);
      const st = { paid: false, regId: null, lines: {}, extra: [], method: null, received: '', cardApproved: false, cardDeclined: false, confirmed: false, sending: false, opId: newOpId(), err: '' };
      let F = null;

      const reg = () => F.registers.find((g) => g.id === st.regId) || null;
      const procsOf = (g) => F.procedures.filter((p) => p.items.length && p.items[0].companyId === g.companyId);
      const unmapped = () => F.procedures.filter((p) => !p.items.length);
      const lineOf = (p) => {
        const l = st.lines[p.id]; if (!l || !l.on) return null;
        const hasVar = p.items.some((i) => i.variant);
        const it = p.items.find((i) => i.variant === (hasVar ? l.variant : ''));
        return { p, l, hasVar, it };
      };
      function calc() {
        const g = reg(); if (!g) return { ok: false, lines: [], problems: [] };
        const lines = [], problems = [];
        for (const p of procsOf(g)) {
          const x = lineOf(p); if (!x) continue;
          if (x.hasVar && !x.l.variant) { problems.push(`Pri výkone „${p.name}“ vyberte jednu alebo obe končatiny.`); continue; }
          if (!x.it) { problems.push(`Výkon „${p.name}“ nemá pre tento variant položku VRP2.`); continue; }
          if (x.it.priceCents == null) { problems.push(`Položka „${x.it.itemName}“ nemá v cenníku cenu – doplní správca.`); continue; }
          const qty = Number(x.l.qty);
          if (!Number.isInteger(qty) || qty < 1 || qty > 9999) { problems.push(`Množstvo pri „${p.name}“ musí byť celé číslo 1 – 9999.`); continue; }
          lines.push({ send: { procedureId: p.id, variant: x.hasVar ? x.l.variant : '', qty }, name: x.it.itemName, unitCents: x.it.priceCents, qty });
        }
        for (const e of st.extra) {
          const it = F.priceItems.find((i) => i.id === e.id);
          const qty = Number(e.qty);
          if (!it || it.companyId !== g.companyId) continue;
          if (it.priceCents == null) { problems.push(`Položka „${it.name}“ nemá v cenníku cenu – doplní správca.`); continue; }
          if (!Number.isInteger(qty) || qty < 1 || qty > 9999) { problems.push(`Množstvo pri „${it.name}“ musí byť celé číslo 1 – 9999.`); continue; }
          lines.push({ send: { priceItemId: it.id, qty }, name: it.name, unitCents: it.priceCents, qty });
        }
        if (!lines.length || problems.length) return { ok: false, lines, problems };
        let sum;
        try { sum = M.compute(lines, st.method || 'card', st.method === 'cash' ? M.parseEur(st.received) : null); } catch (e) { return { ok: false, lines, problems: [e.message] }; }
        return { ok: true, lines, problems, sum };
      }

      function render() {
        if (!F.enabled) {   // platby nie sú zapnuté – pôvodné ukončenie
          box.innerHTML = `<p>Pacient odchádza.</p><div class="row end"><button type="button" class="btn" id="f-cancel">Zrušiť</button>
            <button type="button" class="btn btn-primary" id="f-done">Ukončiť pacienta</button></div>`;
          box.querySelector('#f-cancel').onclick = () => close(null);
          box.querySelector('#f-done').onclick = () => close('done');
          return;
        }
        const g = reg();
        const c = st.paid ? calc() : null;
        const blocks = g ? g.warnings.filter((w) => w.block) : [];
        const warns = g ? g.warnings.filter((w) => !w.block) : [];
        let pay = '';
        if (st.paid) {
          if (!F.registers.length) pay = `<div class="alert alert-danger" role="alert"><div class="grow"><b>Platbu teraz nemožno prijať.</b> ${esc(F.roomNote || 'Chýba nastavenie pokladnice.')}</div></div>`;
          else {
            const regPick = F.registers.length > 1
              ? `<div class="pay-regs" role="radiogroup" aria-label="Účtujúca spoločnosť">${F.registers.map((x) => `<label class="pay-reg ${x.id === st.regId ? 'on' : ''}"><input type="radio" name="f-reg" value="${x.id}" ${x.id === st.regId ? 'checked' : ''}>
                  <b>${esc(x.companyName)}</b><span>${esc(x.label)}</span></label>`).join('')}</div>` : '';
            const procs = g ? procsOf(g) : [];
            const rows = procs.map((p) => {
              const l = st.lines[p.id] || { on: false, variant: '', qty: p.items[0].qty || 1 };
              const hasVar = p.items.some((i) => i.variant);
              const it = p.items.find((i) => i.variant === (hasVar ? l.variant : ''));
              const price = it ? (it.priceCents == null ? '<span class="pay-miss">⚠ chýba cena</span>' : esc(eur(it.priceCents))) : hasVar ? '<span class="hint">vyberte končatinu</span>' : '';
              const tot = l.on && it && it.priceCents != null && Number.isInteger(Number(l.qty)) ? esc(eur(it.priceCents * Number(l.qty))) : '';
              return `<tr class="${l.on ? 'on' : ''}"><td><label class="check"><input type="checkbox" data-proc="${p.id}" ${l.on ? 'checked' : ''}> <b>${esc(p.name)}</b></label>
                  ${l.on && it ? `<div class="hint">doklad: ${esc(it.itemName)}</div>` : ''}</td>
                <td>${hasVar ? `<select data-var="${p.id}" aria-label="Končatina – ${esc(p.name)}" ${l.on ? '' : 'disabled'}><option value="">– končatina –</option>
                  ${p.items.filter((i) => i.variant).map((i) => `<option value="${i.variant}" ${l.variant === i.variant ? 'selected' : ''}>${esc(i.variantText)}</option>`).join('')}</select>` : ''}</td>
                <td><input type="number" min="1" max="9999" step="1" data-qty="${p.id}" value="${esc(String(l.qty))}" aria-label="Množstvo – ${esc(p.name)}" ${l.on ? '' : 'disabled'} style="width:84px"></td>
                <td class="num">${price}</td><td class="num"><b>${tot}</b></td></tr>`;
            }).join('');
            const extraRows = st.extra.map((e, k) => { const it = F.priceItems.find((i) => i.id === e.id); return it ? `<tr class="on"><td><b>${esc(it.name)}</b> <button type="button" class="btn btn-sm btn-ghost" data-extra-del="${k}" title="Odobrať položku">✕</button></td><td></td>
              <td><input type="number" min="1" max="9999" step="1" data-extra-qty="${k}" value="${esc(String(e.qty))}" aria-label="Množstvo – ${esc(it.name)}" style="width:84px"></td>
              <td class="num">${it.priceCents == null ? '<span class="pay-miss">⚠ chýba cena</span>' : esc(eur(it.priceCents))}</td><td class="num"><b>${it.priceCents != null ? esc(eur(it.priceCents * Number(e.qty || 0))) : ''}</b></td></tr>` : ''; }).join('');
            const items = g ? F.priceItems.filter((i) => i.companyId === g.companyId) : [];
            const um = unmapped();
            const sum = c && c.ok ? c.sum : null;
            let methodBox = '';
            if (sum) {
              const cash = st.method === 'cash' ? M.compute(c.lines, 'cash', M.parseEur(st.received)) : null;
              methodBox = `<div class="pay-methods" role="radiogroup" aria-label="Spôsob úhrady">
                  <label class="pay-reg ${st.method === 'cash' ? 'on' : ''}"><input type="radio" name="f-method" value="cash" ${st.method === 'cash' ? 'checked' : ''}><b>Hotovosť</b></label>
                  <label class="pay-reg ${st.method === 'card' ? 'on' : ''}"><input type="radio" name="f-method" value="card" ${st.method === 'card' ? 'checked' : ''}><b>Karta</b></label></div>
                ${st.cardDeclined ? '<div class="alert alert-warn" role="status"><div class="grow"><b>Platba kartou bola zamietnutá – nič sa nezaevidovalo.</b> Skúste kartu znova alebo zvoľte iný spôsob úhrady.</div></div>' : ''}
                ${st.method === 'cash' ? `<div class="pay-cash">
                    <div class="pay-row"><span>Suma dokladu</span><b>${esc(eur(cash.totalCents))}</b></div>
                    <div class="pay-row"><span>Zaokrúhlenie hotovosti (na 5 centov)</span><b>${esc(eur(cash.roundingCents))}</b></div>
                    <div class="pay-row big"><span>Na úhradu v hotovosti</span><b id="f-payable">${esc(eur(cash.payableCents))}</b></div>
                    <div class="pay-row"><label for="f-received">Prijatá suma (€)</label><input id="f-received" inputmode="decimal" autocomplete="off" value="${esc(st.received)}" placeholder="napr. 200" style="width:130px;text-align:right"></div>
                    <div class="pay-row big"><span>Výdavok</span><b id="f-change">${cash.changeCents != null ? esc(eur(cash.changeCents)) : st.received ? '<span class="pay-miss">⚠ prijatá suma je nízka</span>' : '–'}</b></div>
                    <label class="check"><input type="checkbox" id="f-confirm" ${st.confirmed ? 'checked' : ''}> Potvrdzujem, že som hotovosť prijala</label></div>` : ''}
                ${st.method === 'card' ? `<div class="pay-cash">
                    <div class="pay-row big"><span>Zadajte na termináli</span><b id="f-payable">${esc(eur(sum.totalCents))}</b></div>
                    <p class="hint">Kartová platba sa nezaokrúhľuje. Platbu zaevidujte až potom, keď terminál ukáže, že ju schválil.</p>
                    <label class="check"><input type="checkbox" id="f-card-ok" ${st.cardApproved ? 'checked' : ''}> <b>Terminál platbu schválil</b> – platbu som prijala</label>
                    <div><button type="button" class="btn btn-sm" id="f-card-no">Terminál platbu zamietol</button></div></div>` : ''}`;
            }
            pay = `${regPick}
              ${g ? `<div class="pay-company" role="status"><div><span class="hint">Účtuje</span><b id="f-company">${esc(g.companyName)}</b></div>
                <div><span class="hint">Pracovisko</span><b>${esc(F.ticket.roomName || '–')}</b></div>
                <div><span class="hint">Pokladnica</span><b>${esc(g.label)}</b> ${simBadge(g.mode === 'sim')}</div></div>` : ''}
              ${g && g.mode === 'sim' ? '<div class="alert alert-info" role="status"><div class="grow"><b>Skúšobný režim (simulátor VRP2).</b> Vytlačí sa doklad označený SIMULÁCIA – nie je to pokladničný doklad.</div></div>' : ''}
              ${blocks.map((w) => `<div class="alert alert-danger" role="alert"><div class="grow"><b>Platbu teraz nemožno prijať.</b> ${esc(w.text)}</div></div>`).join('')}
              ${warns.map((w) => `<div class="alert alert-warn" role="status"><div class="grow">${esc(w.text)} Platbu môžete prijať – doklad sa vystaví a vytlačí hneď, ako to bude možné.</div></div>`).join('')}
              ${g && !blocks.length ? `<h3>Čo pacient hradí</h3>
                ${procs.length || st.extra.length ? `<table class="pay-items"><thead><tr><th>Výkon</th><th></th><th>Množstvo</th><th class="num">Jednotková cena</th><th class="num">Spolu</th></tr></thead><tbody>${rows}${extraRows}</tbody></table>` : '<div class="empty">Pre túto spoločnosť nie sú nastavené výkony – doplní správca v Nastaveniach.</div>'}
                ${um.length ? `<p class="hint">⚠ Bez položky VRP2 (nedajú sa účtovať, doplní správca): ${um.map((p) => esc(p.name)).join(', ')}.</p>` : ''}
                ${items.length ? `<div class="row"><select id="f-extra" aria-label="Pridať položku z cenníka"><option value="">+ pridať inú položku z cenníka…</option>${items.map((i) => `<option value="${i.id}">${esc(i.name)}${i.priceCents != null ? ' – ' + esc(eur(i.priceCents)) : ' – ⚠ bez ceny'}</option>`).join('')}</select></div>` : ''}
                ${c.problems.map((p) => `<div class="error-text">⚠ ${esc(p)}</div>`).join('')}
                <div class="pay-total"><span>Celková suma</span><b id="f-total">${sum ? esc(eur(sum.totalCents)) : '–'}</b></div>
                ${methodBox}` : ''}`;
          }
        }
        const ready = st.paid && c && c.ok && !blocks.length && st.method && (st.method === 'cash' ? st.confirmed && M.compute(c.lines, 'cash', M.parseEur(st.received)).changeCents != null : st.cardApproved);
        box.innerHTML = `<div class="pay-choice" role="radiogroup" aria-label="Úhrada">
            <label class="pay-reg ${!st.paid ? 'on' : ''}"><input type="radio" name="f-paid" value="0" ${!st.paid ? 'checked' : ''}><b>Bez priamej úhrady</b><span>poisťovňa, kontrola…</span></label>
            <label class="pay-reg ${st.paid ? 'on' : ''}"><input type="radio" name="f-paid" value="1" ${st.paid ? 'checked' : ''}><b>Platba pacienta</b><span>vystaví sa pokladničný doklad</span></label></div>
          ${pay}
          <div class="error-text" id="f-err" role="alert">${st.err ? '⚠ ' + esc(st.err) : ''}</div>
          <div class="row end"><button type="button" class="btn" id="f-cancel" ${st.sending ? 'disabled' : ''}>Zrušiť</button>
            ${st.paid ? `<button type="button" class="btn btn-primary" id="f-pay" ${ready && !st.sending ? '' : 'disabled'}>${st.sending ? 'Ukladá sa…' : 'Ukončiť pacienta a vytlačiť doklad'}</button>`
              : '<button type="button" class="btn btn-primary" id="f-done">Ukončiť pacienta</button>'}</div>`;
        wire(c);
      }

      function keepFocus(fn) {   // prekreslenie nesmie vziať kurzor z poľa, do ktorého sestra píše
        const a = document.activeElement; const key = a && (a.id || a.getAttribute('data-qty') && 'q' + a.getAttribute('data-qty'));
        const pos = a && a.selectionStart;
        fn();
        if (!key) return;
        const n = key[0] === 'q' && !a.id ? box.querySelector(`[data-qty="${key.slice(1)}"]`) : box.querySelector('#' + key);
        if (n) { n.focus(); try { if (pos != null) n.setSelectionRange(pos, pos); } catch {} }
      }

      function wire(c) {
        const q = (s) => box.querySelector(s);
        q('#f-cancel').onclick = () => close(null);
        box.querySelectorAll('input[name=f-paid]').forEach((r) => { r.onchange = () => { st.paid = r.value === '1'; st.err = ''; render(); }; });
        if (q('#f-done')) q('#f-done').onclick = () => close('done');
        box.querySelectorAll('input[name=f-reg]').forEach((r) => { r.onchange = () => { st.regId = Number(r.value); st.lines = {}; st.extra = []; st.method = null; st.confirmed = false; st.cardApproved = false; render(); }; });
        const resetConfirm = () => { st.confirmed = false; st.cardApproved = false; };
        box.querySelectorAll('[data-proc]').forEach((el) => { el.onchange = () => {
          const p = F.procedures.find((x) => x.id === Number(el.dataset.proc));
          st.lines[p.id] = { ...(st.lines[p.id] || { variant: '', qty: (p.items[0] && p.items[0].qty) || 1 }), on: el.checked }; resetConfirm(); render(); }; });
        box.querySelectorAll('[data-var]').forEach((el) => { el.onchange = () => {
          const p = F.procedures.find((x) => x.id === Number(el.dataset.var)); const it = p.items.find((i) => i.variant === el.value);
          st.lines[p.id].variant = el.value; if (it) st.lines[p.id].qty = it.qty || 1; resetConfirm(); render(); }; });
        box.querySelectorAll('[data-qty]').forEach((el) => { el.oninput = () => { st.lines[Number(el.dataset.qty)].qty = el.value === '' ? '' : Number(el.value); resetConfirm(); keepFocus(render); }; });
        box.querySelectorAll('[data-extra-qty]').forEach((el) => { el.onchange = () => { st.extra[Number(el.dataset.extraQty)].qty = Number(el.value); resetConfirm(); render(); }; });
        box.querySelectorAll('[data-extra-del]').forEach((el) => { el.onclick = () => { st.extra.splice(Number(el.dataset.extraDel), 1); resetConfirm(); render(); }; });
        if (q('#f-extra')) q('#f-extra').onchange = (e) => { if (e.target.value) { st.extra.push({ id: Number(e.target.value), qty: 1 }); resetConfirm(); render(); } };
        box.querySelectorAll('input[name=f-method]').forEach((r) => { r.onchange = () => { st.method = r.value; st.cardDeclined = false; resetConfirm(); st.err = ''; render(); }; });
        if (q('#f-received')) q('#f-received').oninput = (e) => { st.received = e.target.value; st.confirmed = false; keepFocus(render); };
        if (q('#f-confirm')) q('#f-confirm').onchange = (e) => { st.confirmed = e.target.checked; render(); };
        if (q('#f-card-ok')) q('#f-card-ok').onchange = (e) => { st.cardApproved = e.target.checked; st.cardDeclined = false; render(); };
        if (q('#f-card-no')) q('#f-card-no').onclick = () => { st.cardApproved = false; st.cardDeclined = true; st.method = null; render(); };
        if (q('#f-pay')) q('#f-pay').onclick = async () => {
          if (st.sending || !c || !c.ok) return;
          const sum = M.compute(c.lines, st.method, st.method === 'cash' ? M.parseEur(st.received) : null);
          st.sending = true; st.err = ''; render();
          try {
            const r = await api(`/api/staff/tickets/${t.id}/finish`, { timeoutMs: 20000, body: { opId: st.opId, registerId: st.regId, method: st.method,
              lines: c.lines.map((l) => l.send), receivedCents: st.method === 'cash' ? M.parseEur(st.received) : undefined,
              paymentConfirmed: st.method === 'cash' ? st.confirmed : st.cardApproved, cardApproved: st.method === 'card' ? st.cardApproved : undefined, expectedPayableCents: sum.payableCents } });
            ctx.toast(`${t.code}: ${r.payment.status.text}`, 'ok');
            close('paid');
          } catch (e) {
            // pri výpadku siete ostáva formulár otvorený s tým istým identifikátorom potvrdenia – opakovanie nevytvorí druhú platbu
            st.sending = false; st.err = e.message + (e.status === 0 ? ' Skúste to znova – platba sa nezaeviduje dvakrát.' : '');
            if (e.status === 409) { try { F = await api(`/api/staff/tickets/${t.id}/finish-form`); if (F.payment) { ctx.toast(`${t.code}: ${F.payment.status.text}`, 'ok'); return close('paid'); } } catch {} }
            if (e.status === 401) { close(null); return ctx.handleError(e); }
            render();
          }
        };
      }

      api(`/api/staff/tickets/${t.id}/finish-form`).then((f) => {
        if (closed) return;
        F = f;
        if (F.payment) { ctx.toast(`${t.code}: ${F.payment.status.text}`, 'ok'); return close('paid'); }
        if (F.registers.length === 1) st.regId = F.registers[0].id;
        render();
        const first = box.querySelector('input[name=f-paid]'); if (first) first.focus();
      }).catch((e) => { close(null); ctx.handleError(e); });
    });
  }

  // ---------- „Doklady na doriešenie“ ----------
  function receiptsSection(items, isAdmin) {
    if (!items || !items.length) return '';
    const rows = items.map((p) => {
      const s = p.status;
      const act = s.issued ? `<button class="btn btn-sm btn-primary needs-online" data-pay-act="reprint" data-pay-id="${p.id}">🖨 Zopakovať tlač</button>`
        : s.action === 'resolve' ? (isAdmin ? `<button class="btn btn-sm btn-primary needs-online" data-pay-act="resolve" data-pay-id="${p.id}">Vyriešiť…</button>` : '<span class="hint">rieši správca</span>')
          : s.code === 'needs_session' ? '<span class="hint">poverená osoba obnoví prihlásenie na PC recepcie</span>' : '<span class="hint">vybaví sa samo</span>';
      return `<tr data-pay-row="${p.id}"><td class="nw">${esc(fmtDateTime ? fmtDateTime(p.confirmedAt) : fmtTime(p.confirmedAt))}</td><td><b>${esc(p.ticketCode)}</b></td>
        <td>${esc(p.roomName)}<div class="hint">${esc(p.companyName)}</div></td><td class="num nw"><b>${esc(eur(p.payableCents))}</b><div class="hint">${METHOD[p.method]}</div></td>
        <td><span class="pay-flag ok">✓ zaplatené</span> ${s.issued ? '<span class="pay-flag ok">✓ doklad vydaný</span>' : '<span class="pay-flag no">✕ doklad nevydaný</span>'}
          <div class="${s.attention ? 'pay-line warn' : 'pay-line'}">${s.attention ? '⚠ ' : ''}${esc(s.text)}</div>${p.lastError && !s.issued ? `<div class="hint">${esc(p.lastError)}</div>` : ''}</td>
        <td class="nw">${p.receipt ? esc(p.receipt.id) : '<span class="hint">—</span>'}</td><td class="actions">${act}</td></tr>`;
    }).join('');
    return `<section class="card a-receipts" id="sec-receipts"><div class="section-title"><h2>Doklady na doriešenie (${items.length})</h2>
      <span class="hint">platba je vo všetkých prípadoch zaevidovaná – pacient už zaplatil</span></div>
      <div class="fin-wrap"><table id="tbl-receipts"><thead><tr><th>Čas</th><th>Číslo</th><th>Pracovisko</th><th class="num">Suma</th><th>Stav</th><th>ID dokladu</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  async function reprint(id, ctx) {
    try {
      const r = await api(`/api/staff/payments/${id}/reprint`, { body: {} });
      ctx.toast(r.duplicate ? 'Tlač už čaká na tlačiareň.' : 'Kópia dokladu odoslaná na tlač – nový doklad sa nevystavuje.', 'ok');
    } catch (e) { ctx.handleError(e); }
  }

  /** Riešenie nejednoznačného prípadu poverenou osobou. */
  async function resolveDialog(id, ctx) {
    let p;
    try { p = (await api(`/api/staff/payments/${id}`)).payment; } catch (e) { return ctx.handleError(e); }
    const started = !!p.submitStartedAt;
    const ev = p.events.map((e) => `<li><span class="hint">${esc(fmtTime(e.at))}</span> ${esc(e.type)}${e.userName ? ` (${esc(e.userName)})` : ''}${e.note ? ` – ${esc(e.note)}` : ''}</li>`).join('');
    return ctx.modal({
      title: `Doklad k návšteve ${p.ticketCode} – ${eur(p.payableCents)}`, okText: 'Potvrdiť',
      body: `<p><b>${esc(p.status.text)}</b></p>${p.lastError ? `<div class="alert alert-warn"><div class="grow">${esc(p.lastError)}</div></div>` : ''}
        <p class="hint">${esc(p.companyName)} · pokladnica ${esc(p.registerLabel)} ${esc(p.registerCode)} · ${METHOD[p.method]} · potvrdila ${esc(p.confirmedBy || '')} o ${esc(fmtTime(p.confirmedAt))}<br>
          ${p.items.map((i) => `${esc(i.name)} – ${i.qty} × ${esc(eur(i.unitCents))}`).join('<br>')}</p>
        <div class="field"><label for="r-act">Čo ste zistili</label><select id="r-act">
          ${started ? `<option value="confirm-issued">Doklad JE v evidencii VRP2 – priradiť jeho ID</option>
            <option value="confirm-missing">Doklad v evidencii VRP2 NIE JE – vystaviť znova</option>`
            : `<option value="retry">Chyba je odstránená – skúsiť znova (do VRP2 sa nič neodoslalo)</option>
            <option value="confirm-issued">Doklad bol vystavený ručne vo VRP2 – priradiť jeho ID</option>`}</select></div>
        <div class="field" id="r-id-f"><label for="r-id">ID dokladu z VRP2</label><input id="r-id" maxlength="80" autocomplete="off"></div>
        <div class="field" id="r-no-f"><label for="r-no">Poradové číslo dokladu (nepovinné)</label><input id="r-no" maxlength="40" autocomplete="off"></div>
        <div class="field" id="r-conf-f"><label for="r-conf">Overili ste v zozname vystavených dokladov VRP2 (položky, suma, čas), že doklad nevznikol? Napíšte NEVYDANÝ</label><input id="r-conf" autocomplete="off"></div>
        <div class="field"><label for="r-note">Poznámka (nepovinné)</label><input id="r-note" maxlength="300"></div>
        <details><summary>Priebeh</summary><ul class="pay-events">${ev}</ul></details>`,
      onOk: async (root) => {
        const v = (s) => root.querySelector(s).value.trim();
        await api(`/api/admin/payments/${id}/resolve`, { body: { action: v('#r-act'), receiptId: v('#r-id'), receiptNumber: v('#r-no'), confirm: v('#r-conf'), note: v('#r-note') } });
        ctx.toast('Zaznamenané.', 'ok');
      },
    });
  }
  // zobrazenie polí podľa zvolenej akcie (modal sa vykresľuje až po zavolaní)
  document.addEventListener('change', (e) => { if (e.target && e.target.id === 'r-act') syncResolve(); });
  function syncResolve() {
    const a = document.getElementById('r-act'); if (!a) return;
    document.getElementById('r-id-f').hidden = document.getElementById('r-no-f').hidden = a.value !== 'confirm-issued';
    document.getElementById('r-conf-f').hidden = a.value !== 'confirm-missing';
  }
  new MutationObserver(syncResolve).observe(document.getElementById('modal-root'), { childList: true });

  // ---------- Nastavenia → Pokladnice VRP2 ----------
  async function renderAdmin(el, ctx) {
    let B, rooms;
    try { [B, rooms] = await Promise.all([api('/api/admin/billing'), api('/api/admin/rooms').then((r) => r.rooms)]); }
    catch (e) { el.innerHTML = `<h2>Platby pacientov a pokladnice VRP2</h2><div class="error-text">⚠ ${esc(e.message)}</div>`; return; }
    const again = () => renderAdmin(el, ctx);
    const run = async (fn, msg) => { try { const r = await fn(); if (msg) ctx.toast(msg, 'ok'); await again(); return r; } catch (e) { ctx.handleError(e); return null; } };
    const coSel = (cur, cls) => `<select class="${cls}">${B.companies.map((c) => `<option value="${c.id}" ${c.id === cur ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`;
    const agSel = (cur) => `<select class="g-agent"><option value="">– bez agenta –</option>${B.agents.map((a) => `<option value="${a.id}" ${a.id === cur ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>`;
    const agState = (a) => (!a.active ? '<span class="pay-flag no">vypnutý</span>' : !a.online ? '<span class="pay-flag no">✕ nepripojený</span>'
      : `<span class="pay-flag ok">✓ pripojený</span> ${a.status ? `režim ${a.status.mode === 'live' ? 'OSTRÝ' : 'simulátor'} · VRP2: ${a.status.session === 'ok' ? 'prihlásený' : a.status.session === 'login_required' ? '⚠ treba prihlásenie' : 'neznáme'}${a.status.activeRegisterCode ? ' · aktívna pokladnica ' + esc(a.status.activeRegisterCode) : ''} · tlačiareň: ${a.status.printer ? (a.status.printer.ok ? 'v poriadku' : '⚠ ' + esc(a.status.printer.message)) : '?'}` : ''}`);
    const itemOpts = (companyId, cur) => `<option value="">–</option>${B.priceItems.filter((i) => i.active && (!companyId || i.companyId === companyId)).map((i) => `<option value="${i.id}" ${i.id === cur ? 'selected' : ''}>${esc(i.name)}${i.priceCents != null ? ' – ' + esc(eur(i.priceCents)) : ' – bez ceny'} (${esc(i.companyName)})</option>`).join('')}`;
    const eurIn = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
    el.innerHTML = `<h2>Platby pacientov a pokladnice VRP2</h2>
      <p class="hint">Sestra pri ukončení platenej návštevy potvrdí platbu a lokálny agent na počítači recepcie vystaví doklad vo VRP2 Finančnej správy a vytlačí ho.
        Nová pokladnica je vždy v <b>skúšobnom režime (simulátor)</b> – ostrý režim zapína správca samostatne pre každú pokladnicu. Návod: docs/POKLADNICA-VRP2.md.</p>
      <label class="check"><input type="checkbox" id="b-enabled" ${B.config.enabled ? 'checked' : ''}> Zapnúť voľbu „Platba pacienta“ vo formulári Ukončiť pacienta</label>

      <h3>Účtujúce spoločnosti</h3>
      <table id="tbl-companies"><thead><tr><th>Názov (na doklade)</th><th style="width:160px">IČO</th><th></th></tr></thead><tbody>
        ${B.companies.map((c) => `<tr data-co="${c.id}"><td><input class="c-name" value="${esc(c.name)}" maxlength="80" style="width:100%"></td><td><input class="c-ico" value="${esc(c.ico)}" maxlength="10" inputmode="numeric" placeholder="vyplní správca"></td>
          <td class="actions"><button class="btn btn-sm btn-primary" data-co-save="${c.id}">Uložiť</button></td></tr>`).join('')}</tbody></table>

      <h3>Lokálni agenti (počítače recepcií)</h3>
      <table id="tbl-agents"><thead><tr><th>Agent</th><th>Stav</th><th></th></tr></thead><tbody>
        ${B.agents.map((a) => `<tr><td><b>${esc(a.name)}</b></td><td>${agState(a)}</td><td class="actions"><button class="btn btn-sm" data-ag-token="${a.id}">Nový token…</button>
          <button class="btn btn-sm" data-ag-toggle="${a.id}" data-on="${a.active ? 1 : 0}">${a.active ? 'Vypnúť' : 'Zapnúť'}</button></td></tr>`).join('') || '<tr><td colspan="3" class="hint">Zatiaľ žiadny agent.</td></tr>'}</tbody></table>
      <form class="row" id="f-agent"><input id="ag-name" placeholder="názov agenta, napr. Recepcia 1" maxlength="60" style="min-width:240px"><button class="btn btn-primary" type="submit">Pridať agenta</button></form>

      <h3>Pokladnice VRP2</h3>
      <table id="tbl-registers"><thead><tr><th>Spoločnosť</th><th>Názov</th><th>Kód pokladnice VRP2</th><th>Agent</th><th>Tlačiareň (názov na PC recepcie)</th><th>Pracoviská</th><th>Režim</th><th></th></tr></thead><tbody>
        ${B.registers.map((g) => `<tr data-reg="${g.id}"><td>${coSel(g.companyId, 'g-co')}</td><td><input class="g-label" value="${esc(g.label)}" maxlength="60"></td>
          <td><input class="g-code" value="${esc(g.vrpCode)}" maxlength="25" inputmode="numeric" style="width:190px"></td><td>${agSel(g.agentId)}</td>
          <td><input class="g-printer" value="${esc(g.printerName)}" maxlength="120"></td>
          <td>${rooms.filter((r) => r.active).map((r) => `<label class="check"><input type="checkbox" class="g-room" value="${r.id}" ${g.roomIds.includes(r.id) ? 'checked' : ''}> ${esc(r.name)}</label>`).join('')}</td>
          <td>${g.mode === 'live' ? '<span class="pay-live">OSTRÝ</span>' : simBadge(true)}</td>
          <td class="actions"><button class="btn btn-sm btn-primary" data-reg-save="${g.id}">Uložiť</button>
            <button class="btn btn-sm" data-reg-test="${g.id}" title="Vytlačí označenú testovaciu stránku – bez dokladu a tržby">Skúšobná tlač</button>
            <button class="btn btn-sm ${g.mode === 'live' ? '' : 'btn-danger'}" data-reg-mode="${g.id}" data-mode="${g.mode}">${g.mode === 'live' ? 'Späť do simulátora' : 'Zapnúť ostrý režim…'}</button></td></tr>`).join('') || '<tr><td colspan="8" class="hint">Zatiaľ žiadna pokladnica.</td></tr>'}</tbody></table>
      <form class="row" id="f-register">${coSel(B.companies[0] && B.companies[0].id, 'ng-co')}<input id="ng-label" placeholder="názov, napr. AdNa – recepcia" maxlength="60">
        <button class="btn btn-primary" type="submit">Pridať pokladnicu</button></form>

      <h3>Cenník – položky presne ako vo VRP2 („Tovary a služby“)</h3>
      <p class="hint">Agent hľadá položku vo VRP2 podľa <b>presného názvu</b> a pred vystavením porovná cenu – pri rozdiele doklad nevystaví. Cenník preto preneste z VRP2:
        export „Tovary a služby“ (xlsx) otvorte, označte riadky s položkami, skopírujte (Ctrl+C) a vložte sem.</p>
      <form class="stack" id="f-import"><div class="row">${coSel(B.companies[0] && B.companies[0].id, 'imp-co')}<button class="btn btn-primary" type="submit">Importovať vložené riadky</button></div>
        <textarea id="imp-text" rows="3" placeholder="Označenie tovaru/služby ⇥ EAN ⇥ Kód tovaru ⇥ Cena s DPH ⇥ Cena bez DPH ⇥ Platnosť od ⇥ Platnosť do"></textarea></form>
      <div class="fin-wrap" style="max-height:340px;overflow:auto"><table id="tbl-prices"><thead><tr><th>Spoločnosť</th><th>Položka VRP2</th><th style="width:130px">Cena (€)</th><th>Aktívna</th><th></th></tr></thead><tbody>
        ${B.priceItems.map((i) => `<tr data-pi="${i.id}" data-co-id="${i.companyId}"><td>${esc(i.companyName)}</td><td><input class="pi-name" value="${esc(i.name)}" maxlength="255" style="width:100%;min-width:320px"></td>
          <td><input class="pi-price" value="${eurIn(i.priceCents)}" inputmode="decimal" placeholder="bez ceny" style="width:110px;text-align:right"></td>
          <td><input type="checkbox" class="pi-active" ${i.active ? 'checked' : ''} style="width:20px;height:20px"></td><td class="actions"><button class="btn btn-sm btn-primary" data-pi-save="${i.id}">Uložiť</button></td></tr>`).join('') || '<tr><td colspan="5" class="hint">Cenník je prázdny.</td></tr>'}</tbody></table></div>
      <form class="row" id="f-price">${coSel(B.companies[0] && B.companies[0].id, 'np-co')}<input id="np-name" placeholder="označenie položky presne ako vo VRP2" maxlength="255" style="flex:1;min-width:260px">
        <input id="np-price" placeholder="cena €" inputmode="decimal" style="width:110px"><button class="btn btn-primary" type="submit">Pridať položku</button></form>

      <h3>Výkony AdNa → položka VRP2</h3>
      <p class="hint">Výkon má buď jednu položku, alebo samostatné položky pre <b>jednu</b> a <b>obe končatiny</b>. Množstvo je predvolené (napr. počet impulzov) – sestra ho vo formulári môže upraviť.</p>
      <table id="tbl-procs"><thead><tr><th>Výkon</th><th>Položka (bez rozlíšenia končatín)</th><th>Jedna končatina</th><th>Obe končatiny</th><th style="width:90px">Množstvo</th><th>Aktívny</th><th></th></tr></thead><tbody>
        ${B.procedures.map((p) => { const m = (v) => p.items.find((i) => i.variant === v); const co = p.items[0] && p.items[0].companyId;
          return `<tr data-proc-row="${p.id}"><td><input class="pr-name" value="${esc(p.name)}" maxlength="80"></td>
          <td><select class="pr-any">${itemOpts(co, m('') && m('').priceItemId)}</select></td><td><select class="pr-one">${itemOpts(co, m('one') && m('one').priceItemId)}</select></td>
          <td><select class="pr-both">${itemOpts(co, m('both') && m('both').priceItemId)}</select></td>
          <td><input type="number" class="pr-qty" min="1" max="9999" value="${(p.items[0] && p.items[0].qty) || 1}" style="width:80px"></td>
          <td><input type="checkbox" class="pr-active" ${p.active ? 'checked' : ''} style="width:20px;height:20px"></td>
          <td class="actions"><button class="btn btn-sm btn-primary" data-proc-save="${p.id}">Uložiť</button><button class="btn btn-sm btn-danger" data-proc-del="${p.id}">Odstrániť</button></td></tr>`; }).join('') || '<tr><td colspan="7" class="hint">Zatiaľ žiadny výkon.</td></tr>'}</tbody></table>
      <form class="row" id="f-proc"><input id="npr-name" placeholder="nový výkon, napr. EVLA" maxlength="80" style="min-width:240px"><button class="btn btn-primary" type="submit">Pridať výkon</button>
        <button class="btn" type="button" id="btn-proc-defaults" title="Cievne vyšetrenie, Duplexná sonografia, EVLA, TEVLA, CLaCS, Sklerotizácia, Miniflebektómia">Pridať bežné výkony (bez cien)</button></form>`;

    const q = (s) => el.querySelector(s);
    const row = (b, attr) => b.closest('tr');
    q('#b-enabled').onchange = (e) => run(() => api('/api/admin/billing/config', { method: 'PUT', body: { enabled: e.target.checked } }), e.target.checked ? 'Platby pacientov sú zapnuté.' : 'Platby pacientov sú vypnuté.');
    el.querySelectorAll('[data-co-save]').forEach((b) => { b.onclick = () => { const r = row(b); run(() => api(`/api/admin/billing/companies/${b.dataset.coSave}`, { method: 'PUT', body: { name: r.querySelector('.c-name').value, ico: r.querySelector('.c-ico').value.trim() } }), 'Spoločnosť uložená.'); }; });
    const showToken = (r) => r && r.token && ctx.modal({ title: 'Token agenta – zobrazí sa len teraz', okText: 'Mám ho uložený', cancelText: 'Zavrieť',
      body: `<p>Vložte ho do súboru <b>konfiguracia.json</b> na počítači recepcie (položka „token“). Neposielajte ho e-mailom ani ho neukladajte inde.</p><div class="field"><input readonly value="${esc(r.token)}" onfocus="this.select()" style="font-family:monospace"></div>` });
    q('#f-agent').onsubmit = async (e) => { e.preventDefault(); const name = q('#ag-name').value; try { const r = await api('/api/admin/billing/agents', { body: { name } }); await again(); showToken(r); } catch (er) { ctx.handleError(er); } };
    el.querySelectorAll('[data-ag-token]').forEach((b) => { b.onclick = async () => { if (!(await ctx.confirm('Vydať nový token?', 'Starý token prestane platiť – agent na recepcii sa odpojí, kým mu nový token nevložíte do konfigurácie.', 'Vydať nový token', true))) return;
      try { const r = await api(`/api/admin/billing/agents/${b.dataset.agToken}`, { method: 'PUT', body: { newToken: true } }); await again(); showToken(r); } catch (er) { ctx.handleError(er); } }; });
    el.querySelectorAll('[data-ag-toggle]').forEach((b) => { b.onclick = () => run(() => api(`/api/admin/billing/agents/${b.dataset.agToggle}`, { method: 'PUT', body: { active: b.dataset.on !== '1' } }), 'Agent uložený.'); });
    el.querySelectorAll('[data-reg-save]').forEach((b) => { b.onclick = () => { const r = row(b); run(() => api(`/api/admin/billing/registers/${b.dataset.regSave}`, { method: 'PUT', body: {
      companyId: Number(r.querySelector('.g-co').value), label: r.querySelector('.g-label').value, vrpCode: r.querySelector('.g-code').value.trim(), agentId: r.querySelector('.g-agent').value || null,
      printerName: r.querySelector('.g-printer').value, roomIds: [...r.querySelectorAll('.g-room:checked')].map((x) => Number(x.value)) } }), 'Pokladnica uložená.'); }; });
    el.querySelectorAll('[data-reg-test]').forEach((b) => { b.onclick = async () => {
      try {
        const { jobId } = await api(`/api/admin/billing/registers/${b.dataset.regTest}/test-print`, { body: {} });
        ctx.toast('Skúšobná tlač odoslaná agentovi…', 'ok');
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          const { print } = await api(`/api/admin/billing/print-jobs/${jobId}`);
          if (print.status === 'sent' || print.status === 'printed') return ctx.toast(print.status === 'printed' ? 'Skúšobná stránka vytlačená.' : 'Skúšobná stránka odoslaná na tlačiareň – skontrolujte výtlačok.', 'ok');
          if (print.status === 'failed') return ctx.toast('⚠ Skúšobná tlač zlyhala: ' + (print.message || ''), 'error');
        }
        ctx.toast('⚠ Agent si skúšobnú tlač neprevzal – je pripojený?', 'error');
      } catch (e) { ctx.handleError(e); } }; });
    el.querySelectorAll('[data-reg-mode]').forEach((b) => { b.onclick = async () => {
      if (b.dataset.mode === 'live') return run(() => api(`/api/admin/billing/registers/${b.dataset.regMode}/mode`, { body: { mode: 'sim' } }), 'Pokladnica je v skúšobnom režime.');
      await ctx.modal({ title: 'Zapnúť ostrý režim pokladnice?', okText: 'Zapnúť ostrý režim', okClass: 'btn-danger solid',
        body: `<p>Od tejto chvíle bude každá potvrdená platba na tejto pokladnici <b>skutočným pokladničným dokladom vo VRP2 Finančnej správy</b>.</p>
          <p class="hint">Predtým: agent na recepcii musí bežať v ostrom režime s overeným ovládaním VRP2, prihlásený do správnej pokladnice, skúšobná tlač v poriadku (docs/POKLADNICA-VRP2.md).</p>
          <div class="field"><label for="lv-conf">Na potvrdenie napíšte OSTRÁ</label><input id="lv-conf" autocomplete="off"></div>`,
        onOk: async (root) => { await api(`/api/admin/billing/registers/${b.dataset.regMode}/mode`, { body: { mode: 'live', confirm: root.querySelector('#lv-conf').value.trim() } }); ctx.toast('Pokladnica je v OSTROM režime.', 'ok'); } });
      again(); }; });
    q('#f-register').onsubmit = (e) => { e.preventDefault(); run(() => api('/api/admin/billing/registers', { body: { companyId: Number(q('.ng-co').value), label: q('#ng-label').value, roomIds: [] } }), 'Pokladnica pridaná (skúšobný režim).'); };
    q('#f-import').onsubmit = async (e) => { e.preventDefault(); const r = await run(() => api('/api/admin/billing/price-import', { timeoutMs: 30000, body: { companyId: Number(q('.imp-co').value), text: q('#imp-text').value } }));
      if (r) ctx.toast(`Import: pridané ${r.added}, aktualizované ${r.updated}, preskočené ${r.skipped}${r.errors.length ? ', ⚠ chyby: ' + r.errors.slice(0, 3).join('; ') : ''}.`, r.errors.length ? 'error' : 'ok'); };
    const priceOf = (s) => { s = String(s).trim(); if (!s) return null; const c = M.parseEur(s); if (c == null) throw new Error('Cena musí byť číslo s najviac dvomi desatinnými miestami.'); return c; };
    el.querySelectorAll('[data-pi-save]').forEach((b) => { b.onclick = () => { const r = row(b); run(async () => api(`/api/admin/billing/price-items/${b.dataset.piSave}`, { method: 'PUT', body: {
      companyId: Number(r.dataset.coId), name: r.querySelector('.pi-name').value, priceCents: priceOf(r.querySelector('.pi-price').value), active: r.querySelector('.pi-active').checked } }), 'Položka uložená.'); }; });
    q('#f-price').onsubmit = (e) => { e.preventDefault(); run(async () => api('/api/admin/billing/price-items', { body: { companyId: Number(q('.np-co').value), name: q('#np-name').value, priceCents: priceOf(q('#np-price').value) } }), 'Položka pridaná.'); };
    el.querySelectorAll('[data-proc-save]').forEach((b) => { b.onclick = () => { const r = row(b); const qty = Number(r.querySelector('.pr-qty').value) || 1;
      const items = [['', '.pr-any'], ['one', '.pr-one'], ['both', '.pr-both']].map(([variant, s]) => ({ variant, priceItemId: Number(r.querySelector(s).value), qty })).filter((i) => i.priceItemId);
      run(() => api(`/api/admin/billing/procedures/${b.dataset.procSave}`, { method: 'PUT', body: { name: r.querySelector('.pr-name').value, active: r.querySelector('.pr-active').checked, items } }), 'Výkon uložený.'); }; });
    el.querySelectorAll('[data-proc-del]').forEach((b) => { b.onclick = async () => { if (await ctx.confirm('Odstrániť výkon?', 'Už potvrdené platby a doklady sa nezmenia.', 'Odstrániť', true)) run(() => api(`/api/admin/billing/procedures/${b.dataset.procDel}`, { method: 'DELETE' }), 'Výkon odstránený.'); }; });
    q('#f-proc').onsubmit = (e) => { e.preventDefault(); run(() => api('/api/admin/billing/procedures', { body: { name: q('#npr-name').value, items: [] } }), 'Výkon pridaný – priraďte mu položku VRP2.'); };
    q('#btn-proc-defaults').onclick = async () => {
      const have = new Set(B.procedures.map((p) => p.name));
      try { for (const n of ['Cievne vyšetrenie', 'Duplexná sonografia', 'EVLA', 'TEVLA', 'CLaCS', 'Sklerotizácia', 'Miniflebektómia']) if (!have.has(n)) await api('/api/admin/billing/procedures', { body: { name: n, items: [] } }); ctx.toast('Výkony pridané – priraďte im položky VRP2.', 'ok'); } catch (e) { ctx.handleError(e); }
      again();
    };
  }

  window.AdNaPokladnica = { finishDialog, payLine, receiptsSection, reprint, resolveDialog, renderAdmin, simBadge };
}());
