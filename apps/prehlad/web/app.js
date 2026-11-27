// AdNa – Prehľad: živý stav ambulancie na diaľku (mobil, Android appka „AdNa Prehľad“). Len na čítanie –
// nič nevyvoláva ani nemení. 2026-11-27 (Pali): „chcem mať prehľad o aktuálnom stave ambulancie, aj keď nie som tam“.
// Ochrana údajov: zobrazujú sa len poradové čísla, typ návštevy a časy – identifikátor pacienta (meno/poznámka sestry)
// sa na diaľku nezobrazuje a v telefóne sa nič neukladá (service worker drží len súbory aplikácie).
(function () {
  'use strict';
  const { api, connect, fmtTime, fmtDay, esc } = window.AdNa;
  const $ = (s, r = document) => r.querySelector(s);
  const S = { user: null, staff: null, conn: null, today: null, todayErr: null, week: null, lastAt: 0, statsTimer: null,
    // obdobie tabuľky lekárov (správca): dnes / tyzden / mesiac / rok / vlastne – pamätá sa v telefóne
    period: (() => { try { return JSON.parse(localStorage.getItem('adna-prehlad-obdobie')) || { p: 'dnes' }; } catch { return { p: 'dnes' }; } })(), weekErr: null, docToday: null };
  const view = $('#view');

  const fmtMin = (m) => (m == null ? '–' : m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}` : `${m} min`);
  const minsSince = (iso) => (iso ? Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)) : null);
  const isoDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bratislava' }).format(d);
  const err = (m) => `<p class="err" role="alert">⚠ ${esc(m)}</p>`;

  // ---------- prihlásenie ----------
  async function start() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    try { S.user = (await api('/api/auth/me')).user; }
    catch (e) { if (e.status === 401) return showLogin(); return showFatal(e.message); }
    showApp();
  }
  function showFatal(msg) {
    $('#topbar').hidden = true;
    view.innerHTML = `<section class="card login">${err(msg)}<button class="btn btn-primary" id="retry">Skúsiť znova</button></section>`;
    $('#retry').onclick = start;
  }
  function showLogin(msg) {
    if (S.conn) { S.conn.stop(); S.conn = null; }
    clearInterval(S.statsTimer);
    S.user = null; S.staff = null; S.today = null; S.todayErr = null; S.week = null; S.weekErr = null; S.docToday = null; S.nurseWeek = null;   // po odhlásení nič z predchádzajúceho konta
    $('#topbar').hidden = true;
    view.innerHTML = `<section class="card login">
      <img class="login-logo" src="adna-logo.png" alt="AdNa s.r.o.">
      <h1>Prehľad ambulancie</h1>
      <p class="hint">Prihláste sa rovnakým kontom ako v aplikácii Sestra.</p>
      ${msg ? err(msg) : ''}
      <form id="login-form" autocomplete="on">
        <label>Meno konta<input id="un" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
        <label>Heslo<span class="pw-row"><input id="pw" name="password" type="password" autocomplete="current-password" required>
          <button type="button" class="btn btn-sm" id="pw-toggle" aria-label="Zobraziť heslo">Zobraziť</button></span></label>
        <div id="login-err"></div>
        <button class="btn btn-primary btn-block" id="btn-login">Prihlásiť sa</button>
      </form></section>`;
    $('#pw-toggle').onclick = () => { const p = $('#pw'); const show = p.type === 'password'; p.type = show ? 'text' : 'password'; $('#pw-toggle').textContent = show ? 'Skryť' : 'Zobraziť'; };
    $('#login-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const b = $('#btn-login'); b.disabled = true; $('#login-err').innerHTML = '';
      try {
        S.user = (await api('/api/auth/login', { body: { username: $('#un').value.trim(), password: $('#pw').value, deviceLabel: 'Prehľad (mobil)' } })).user;
        showApp();
      } catch (e) { $('#login-err').innerHTML = err(e.message); b.disabled = false; }
    };
    $('#un').focus();
  }
  $('#btn-logout').onclick = async () => { try { await api('/api/auth/logout', { body: {} }); } catch {} showLogin(); };

  // ---------- živé údaje ----------
  function showApp() {
    $('#topbar').hidden = false;
    $('#brand-sub').textContent = S.user.doctorName || S.user.nurseName || S.user.username;
    view.innerHTML = '<div class="center-msg">Načítava sa…</div>';
    S.conn = connect('staff', {
      onMessage: (m) => { if (m.type === 'staff.state') { S.staff = m.state; S.lastAt = Date.now(); render(); statsSoon(); } },
      onStatus: (s) => {
        const c = $('#conn');
        c.className = 'conn conn-' + s;
        c.textContent = s === 'online' ? 'Živé údaje' : s === 'connecting' ? 'Pripája sa…' : '⚠ Bez spojenia';
        if (s === 'offline' && S.staff) render();
      },
      onUnauthorized: () => showLogin('Prihlásenie vypršalo. Prihláste sa znova.'),
    });
    loadStats();
    clearInterval(S.statsTimer);
    S.statsTimer = setInterval(() => { if (!document.hidden) { loadStats(); render(); } }, 60000);
  }
  let statsT = null;
  function statsSoon() { clearTimeout(statsT); statsT = setTimeout(loadStats, 1500); }
  async function loadStats() {
    if (!S.user) return;
    // dnešné štatistiky – sestra a správca (lekárske konto ich nemá, vidí len živý stav)
    if (!S.user.doctorName) {
      try { S.today = await api('/api/staff/today-stats'); S.todayErr = null; } catch (e) { if (e.status === 401) return showLogin('Prihlásenie vypršalo. Prihláste sa znova.'); S.todayErr = e.status === 403 ? null : e.message; }
    }
    if (S.user.role === 'admin') {
      const td = isoDay(new Date());
      try { S.docToday = await api(`/api/admin/stats?from=${td}&to=${td}&groupBy=doctor`); } catch { S.docToday = null; }
      const { from, to } = periodRange();
      try { S.nurseWeek = await api(`/api/admin/stats?from=${from}&to=${to}&groupBy=nurse`); } catch { S.nurseWeek = null; }
      try { S.week = await api(`/api/admin/stats?from=${from}&to=${to}&groupBy=doctor`); S.weekErr = null; }
      catch (e) { S.week = null; S.weekErr = e.message; }
    }
    render();
  }

  // ---------- vykreslenie ----------
  function render() {
    const st = S.staff;
    if (!st || !S.user) return;
    if (document.activeElement && document.activeElement.matches && document.activeElement.matches('#view input[type=date]')) return;
    const y = window.scrollY;
    const ts = st.tickets || [];
    const w = ts.filter((t) => t.status === 'waiting'), c = ts.filter((t) => t.status === 'called');
    const wn = w.filter((t) => (t.stage || 'nurse') === 'nurse'), wd = w.filter((t) => t.stage === 'doctor');
    const oldest = (list, f) => { const xs = list.map(f).filter(Boolean).sort(); return xs.length ? minsSince(xs[0]) : null; };
    const offline = $('#conn').classList.contains('conn-offline');
    const kpi = (n, label, sub, cls = '') => `<div class="kpi ${cls}"><b>${n}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
    view.innerHTML = `
      ${offline ? `<div class="banner warn" role="alert">⚠ Spojenie so serverom je prerušené – údaje nižšie môžu byť staré (naposledy ${fmtTime(new Date(S.lastAt).toISOString())}). Obnovuje sa automaticky.</div>` : ''}
      <section class="card head-card">
        <div><h1>${esc(fmtDay(st.day))}</h1><p class="hint">Aktualizované ${fmtTime(st.serverTime)} · obnovuje sa samo</p></div>
        ${st.dayEnd ? `<span class="pill pill-dark">Deň ukončený o ${fmtTime(st.dayEnd.at)}</span>` : ''}
      </section>
      ${(st.autoDone || []).map((a) => `<div class="banner warn" role="alert">⚠ Pacient č. <b>${esc(a.code)}</b>${a.room ? ` (${esc(a.room)})` : ''} bol o ${fmtTime(a.at)} ukončený automaticky – ${esc(a.note || 'zabudnuté ukončenie')}${a.who ? `: <b>${esc(a.who)}</b>` : ''} (od ${fmtTime(a.since)}).</div>`).join('')}
      ${st.announcement ? `<div class="banner info">Oznam na TV: ${esc(st.announcement.text || '')}</div>` : ''}
      <section class="card"><h2>Práve teraz</h2><div class="kpis">
        ${kpi(wn.length, 'čaká na sestru', wn.length ? 'najdlhšie ' + fmtMin(oldest(wn, (t) => t.createdAt)) : '')}
        ${kpi(c.filter((t) => t.stage !== 'doctor' && t.stage !== 'final').length, 'u sestry')}
        ${kpi(wd.length, 'čaká na lekára', wd.length ? 'najdlhšie ' + fmtMin(oldest(wd, (t) => t.toDoctorAt)) : '')}
        ${kpi(c.filter((t) => t.stage === 'doctor').length, 'u lekára')}
        ${kpi(c.filter((t) => t.stage === 'final').length, 'na ukončení')}
        ${kpi(st.counts.done || 0, 'ukončených dnes', '', 'kpi-ok')}
        ${st.counts.absent ? kpi(st.counts.absent, 'neprišli / odišli') : ''}
      </div></section>
      ${renderRooms(st, w, c)}
      ${renderWaiting(st, w)}
      ${renderToday()}
      ${renderWeek()}
      ${S.user.role === 'admin' ? '<p class="foot"><a class="btn" href="/sestra/">Otvoriť plnú aplikáciu Sestra (história, štatistiky za obdobie)</a></p>' : ''}
      <p class="foot hint">Prehľad je len na čítanie. Identifikátory pacientov sa tu nezobrazujú.</p>`;
    window.scrollTo(0, y);
  }

  const pac = (n) => (n === 1 ? 'pacienta' : 'pacientov');
  function renderRooms(st, w, c) {
    const rooms = (st.rooms || []).filter((r) => r.active);
    if (!rooms.length) return '';
    const closed = st.roomsClosed || [];
    const rid = (t) => t.roomId ?? t.homeRoomId;
    const now = Date.now();
    const late = (t) => { if (!t.plannedAt) return null; return Math.round((now - Math.max(new Date(t.plannedAt).getTime(), new Date(t.createdAt).getTime() || 0)) / 60000); };
    const card = (r) => {
      const W = w.filter((t) => rid(t) === r.id || (rid(t) == null && rooms.length === 1));
      const C = c.filter((t) => t.roomId === r.id);
      const atNurse = C.filter((t) => t.stage !== 'doctor' && t.stage !== 'final'), atDoc = C.filter((t) => t.stage === 'doctor'), atFinal = C.filter((t) => t.stage === 'final');
      const wn = W.filter((t) => (t.stage || 'nurse') === 'nurse'), wd = W.filter((t) => t.stage === 'doctor');
      const ls = [...W, ...atNurse].map(late).filter((x) => x != null);
      const mx = ls.length ? Math.max(...ls) : null;
      const isClosed = closed.includes(r.id);
      const badge = isClosed ? '<span class="pill pill-grey">Dnes neordinuje</span>'
        : atDoc.length ? '<span class="pill pill-red">Pacient u lekára</span>'
        : atNurse.length || atFinal.length ? '<span class="pill pill-blush">Pacient u sestry</span>' : '<span class="pill pill-ok">Voľná</span>';
      const who = (list, label) => list.map((t) => `<li>Pacient č. <b class="code">${esc(t.code)}</b> – ${label} <span class="hint">od ${fmtTime(t.calledAt)} (${fmtMin(minsSince(t.calledAt))})</span></li>`).join('');
      const people = [st.doctors?.[r.id] && `Lekár: <b>${esc(st.doctors[r.id])}</b>`, st.nurses?.[r.id] && `Sestra: <b>${esc(st.nurses[r.id])}</b>`].filter(Boolean).join(' · ');
      // koľko pacientov dnes lekár tejto ambulancie vyšetril (správca: podľa lekára, inak podľa ambulancie)
      const dn = st.doctors?.[r.id];
      const dRow = S.docToday && dn ? (S.docToday.doctors || []).find((x) => x.doctor === dn) : null;
      const rRow = !S.docToday && S.today ? (S.today.rooms || []).find((x) => x.name === r.name) : null;
      const examined = dRow ? `<p class="room-count">Lekár dnes vyšetril: <b>${dRow.patients}</b> ${pac(dRow.patients)}</p>`
        : S.docToday && dn ? '<p class="room-count">Lekár dnes vyšetril: <b>0</b> pacientov</p>'
        : rRow ? `<p class="room-count">Dnes v ambulancii: <b>${rRow.patients}</b> ${pac(rRow.patients)}</p>` : '';
      return `<article class="room">
        <div class="room-head"><h3>${esc(r.name)}</h3>${badge}</div>
        ${people ? `<p class="room-people">${people}</p>` : '<p class="room-people hint">Lekár a sestra dnes zatiaľ nezadaní</p>'}
        ${examined}
        ${C.length ? `<ul class="room-now">${who(atNurse, 'u sestry')}${who(atDoc, 'u lekára')}${who(atFinal, 'na ukončení u sestry')}</ul>` : ''}
        <div class="room-nums">
          <span><b>${wn.length}</b> čaká na sestru</span><span><b>${wd.length}</b> čaká na lekára</span>
          <span>${mx == null ? 'meškanie –' : mx > 5 ? `<b class="late">⏱ mešká ${fmtMin(mx)}</b>` : '<b class="ok">v čase</b>'}</span>
        </div></article>`;
    };
    return `<section class="card"><h2>Ambulancie</h2><div class="rooms">${rooms.map(card).join('')}</div></section>`;
  }

  function renderWaiting(st, w) {
    if (!w.length) return '<section class="card"><h2>Čakáreň</h2><p class="hint">Nikto nečaká.</p></section>';
    const order = (t) => (t.stage === 'doctor' ? '1' + (t.toDoctorAt || t.createdAt) : '0' + (t.plannedAt || t.createdAt));
    const rows = [...w].sort((a, b) => order(a).localeCompare(order(b))).map((t) => {
      const since = t.stage === 'doctor' ? t.toDoctorAt || t.createdAt : t.createdAt;
      const l = t.plannedAt ? Math.round((Date.now() - Math.max(new Date(t.plannedAt).getTime(), new Date(t.createdAt).getTime())) / 60000) : null;
      return `<tr><td><b class="code">${esc(t.code)}</b>${t.patientType ? `<br><span class="tag">${esc(t.patientType)}</span>` : ''}</td>
        <td>${t.stage === 'doctor' ? 'na lekára' : 'na sestru'}<br><span class="hint">${esc(t.homeRoomName || t.roomName || '–')}</span></td>
        <td class="num">${t.plannedAt ? fmtTime(t.plannedAt) : '–'}${l != null && l > 5 && t.stage !== 'doctor' ? `<br><span class="late">+${fmtMin(l)}</span>` : ''}</td>
        <td class="num"><b>${fmtMin(minsSince(since))}</b></td></tr>`;
    }).join('');
    return `<section class="card"><h2>Čakáreň <span class="count">${w.length}</span></h2>
      <div class="scroll"><table class="tbl"><thead><tr><th>Číslo</th><th>Čaká</th><th class="num">Termín</th><th class="num">Čaká už</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  function diffText(m) { return m == null ? '–' : m > 0 ? `<span class="late">+${fmtMin(m)}</span>` : m < 0 ? `<span class="ok">−${fmtMin(-m)}</span>` : 'v čase'; }
  function renderToday() {
    if (S.user.doctorName) return '';
    if (S.todayErr) return `<section class="card"><h2>Dnes spolu</h2>${err(S.todayErr)}</section>`;
    const d = S.today;
    if (!d) return '';
    const t = d.total || {};
    const pct = t.planned ? Math.round((t.onTime / t.planned) * 100) + ' %' : '–';
    const tile = (v, l) => `<div class="kpi kpi-soft"><b>${v}</b><span>${l}</span></div>`;
    const rows = (d.rooms || []).map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${r.patients}</td><td class="num">${r.done}</td>
      <td class="num">${fmtMin(r.avgWait)}</td><td class="num">${diffText(r.avgDocDiff ?? r.avgDiff)}</td><td class="num">${fmtMin(r.avgDoctor ?? r.avgExam)}</td></tr>`).join('');
    return `<section class="card"><h2>Dnes spolu</h2>
      ${t.patients ? `<div class="kpis">
        ${tile(t.patients, 'vyvolaných pacientov')}${tile(t.done, 'ukončených')}
        ${tile(fmtMin(t.avgWait), 'priem. čakanie na sestru')}${tile(fmtMin(t.avgDoctorWait), 'priem. čakanie na lekára')}
        ${tile(fmtMin(t.avgNurse), 'priem. čas u sestry')}${tile(fmtMin(t.avgDoctor), 'priem. čas u lekára')}
        ${tile(pct, 'načas k sestre (do 5 min)')}${tile(t.late15 || 0, 'meškanie viac ako 15 min')}
      </div>
      ${rows ? `<div class="scroll"><table class="tbl"><thead><tr><th>Ambulancia</th><th class="num">Pac.</th><th class="num">Hotovo</th><th class="num">Čakanie</th><th class="num">Mešk.</th><th class="num">U lek.</th></tr></thead><tbody>${rows}</tbody></table></div><p class="hint">Pac. = všetci pacienti ambulancie, aj tí, čo boli len u sestry. Mešk. = priemer oproti termínu po vstup k lekárovi, U lek. = priemerný čas u lekára.</p>` : ''}`
      : '<p class="hint">Dnes ešte nikto nebol vyvolaný.</p>'}</section>`;
  }

  // ---------- lekári za obdobie (len správca) ----------
  const STATS_START = '2026-11-23';   // ostrý štart štatistík
  const PERIODS = [['dnes', 'Dnes'], ['tyzden', 'Týždeň'], ['mesiac', 'Mesiac'], ['rok', 'Rok'], ['vlastne', 'Od – do']];
  function periodRange() {
    const now = new Date(), today = isoDay(now), P = S.period || { p: 'dnes' };
    let from = today, to = today;
    if (P.p === 'tyzden') from = isoDay(new Date(now.getTime() - ((now.getDay() + 6) % 7) * 86400000));
    else if (P.p === 'mesiac') from = today.slice(0, 8) + '01';
    else if (P.p === 'rok') from = today.slice(0, 5) + '01-01';
    else if (P.p === 'vlastne') { from = P.from || today; to = P.to || today; if (to > today) to = today; if (from > to) from = to; }
    if (from < STATS_START) from = STATS_START;
    if (to < from) to = from;
    return { from, to };
  }
  function setPeriod(p) {
    S.period = p;
    try { localStorage.setItem('adna-prehlad-obdobie', JSON.stringify(p)); } catch {}
    S.week = null; render(); loadStats();
  }
  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-period]');
    if (!b) return;
    const p = b.dataset.period;
    if (p === 'vlastne') { const r = periodRange(); setPeriod({ p, from: S.period.from || r.from, to: S.period.to || r.to }); }
    else setPeriod({ p });
  });
  view.addEventListener('change', (e) => {
    if (!e.target.matches('input[data-od], input[data-do]')) return;
    const from = view.querySelector('input[data-od]').value, to = view.querySelector('input[data-do]').value;
    if (from && to) { e.target.blur(); setPeriod({ p: 'vlastne', from: from <= to ? from : to, to: from <= to ? to : from }); }
  });

  function renderWeek() {
    if (!S.user || S.user.role !== 'admin') return '';
    const P = S.period || { p: 'dnes' }, { from, to } = periodRange(), d = S.week, today = isoDay(new Date());
    const title = { dnes: 'Lekári dnes', tyzden: 'Lekári tento týždeň', mesiac: 'Lekári tento mesiac', rok: 'Lekári tento rok', vlastne: 'Lekári za obdobie' }[P.p] || 'Lekári';
    const chips = PERIODS.map(([k, l]) => `<button type="button" class="chip${P.p === k ? ' chip-on' : ''}" data-period="${k}" aria-pressed="${P.p === k}">${l}</button>`).join('');
    const custom = P.p === 'vlastne' ? `<div class="range"><label>Od <input type="date" data-od min="${STATS_START}" max="${today}" value="${esc(from)}"></label>
      <label>Do <input type="date" data-do min="${STATS_START}" max="${today}" value="${esc(to)}"></label></div>` : '';
    let rows = d && d.from === from && d.to === to ? d.doctors.slice() : null;
    // dnes ukáž aj lekárov zadaných pri ambulanciách, ktorí ešte nemali pacienta
    if (rows && P.p === 'dnes' && S.staff && S.staff.doctors) {
      for (const n of Object.values(S.staff.doctors)) if (n && !rows.some((r) => r.doctor === n)) rows.push({ doctor: n, patients: 0, done: 0, days: 0 });
    }
    const oneDay = from === to;
    const anyForgot = !!(rows && rows.some((r) => r.forgot));
    const body = S.weekErr ? `<p class="banner warn" role="alert">⚠ Štatistiky sa nepodarilo načítať: ${esc(S.weekErr)}</p>`
      : !rows ? '<p class="hint">Načítavam…</p>'
      : !rows.length ? '<p class="hint">Za toto obdobie nie sú žiadni pacienti.</p>'
      : `<p class="hint">${oneDay ? esc(fmtDay(from)) : `${esc(fmtDay(from))} – ${esc(fmtDay(to))}`} · u lekárov: <b>${d.total.patients}</b> pacientov (ukončených ${d.total.done})${d.nurseOnly ? ` + <b>${d.nurseOnly}</b> len u sestry (k lekárovi nešli) = <b>${d.total.patients + d.nurseOnly}</b> v ambulanciách spolu` : ''}</p>
      <div class="scroll"><table class="tbl"><thead><tr><th>Lekár</th><th class="num">Pac.</th><th class="num">Ukonč.</th>${oneDay ? '' : '<th class="num">Dní</th>'}<th class="num">Čakanie</th><th class="num">Mešk.</th><th class="num">U lek.</th>${anyForgot ? '<th class="num">Zabudnuté</th>' : ''}</tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.doctor)}</td><td class="num">${r.patients}</td><td class="num">${r.done ?? '–'}</td>${oneDay ? '' : `<td class="num">${r.days ?? '–'}</td>`}
        <td class="num">${r.patients ? fmtMin(r.avgWait) : '–'}</td><td class="num">${r.patients ? diffText(r.avgDocDiff) : '–'}</td><td class="num">${r.patients ? fmtMin(r.avgExam) : '–'}</td>${anyForgot ? `<td class="num">${r.forgot ? `<b class="late">⚠ ${r.forgot}</b>` : '0'}</td>` : ''}</tr>`).join('')}
      </tbody></table></div><p class="hint">Pac. = pacienti, ktorí boli u lekára. Čakanie = priemerné čakanie, Mešk. = oproti termínu po vstup k lekárovi, U lek. = priemerný čas u lekára. ${anyForgot ? ' Zabudnuté = pacient, ktorého lekár neposlal na ukončenie a server ho ukončil sám po 2 h.' : ''} Štatistiky sa počítajú od 23. 11. 2026.</p>`;
    // zabudnuté ukončenia (pacient ostal na ukončení u sestry alebo u sestry) – podľa sestier
    const nf = S.nurseWeek && S.nurseWeek.from === from && S.nurseWeek.to === to ? (S.nurseWeek.doctors || []).filter((r) => r.forgot) : [];
    const df = rows ? rows.filter((r) => r.forgot) : [];
    const forgotBox = nf.length || df.length ? `<div class="banner warn" role="status">⚠ <b>Zabudnuté ukončenia</b> (server pacienta ukončil sám po 2 h):
      ${[...nf.map((r) => `${esc(r.doctor)} ${r.forgot}×`), ...df.map((r) => `${esc(r.doctor)} ${r.forgot}× (neposlal na ukončenie)`)].join(', ')}</div>` : '';
    return `<section class="card" id="lekari"><h2>${title}</h2><div class="chips" role="group" aria-label="Obdobie">${chips}</div>${custom}${forgotBox}${body}</section>`;
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.user) { loadStats(); render(); } });
  start();
})();
