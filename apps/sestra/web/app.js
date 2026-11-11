// AdNa – aplikácia pre sestru. Bez závislostí, používa /shared/adna-client.js (window.AdNa).
(function () {
  'use strict';
  const { api, connect, esc, fmtTime, fmtDateTime, fmtDay, fmtWait, STATUS_TEXT, PRINT_TEXT } = window.AdNa;

  const $view = document.getElementById('view');
  const $topbar = document.getElementById('topbar');
  const $conn = document.getElementById('conn');
  const LS_ROOM = 'adna.sestra.defaultRoom';
  const LS_USER = 'adna.sestra.user';
  const LS_ALL = 'adna.sestra.showAll';

  const S = {
    user: null,
    staff: null,         // posledný úplný stav zo servera (StaffState)
    conn: 'connecting',
    view: 'queue',
    roomId: null,        // vybraná ambulancia pre vyvolanie
    socket: null,
    busy: false,         // prebieha akcia – zabráni dvojitému kliknutiu
    historyDay: null,
    statsFrom: null, statsTo: null,
  };

  // ---------- pomocné ----------
  function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    const box = document.getElementById('toasts');
    box.appendChild(el);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
  }

  /** Jednoduché modálne okno. Vráti Promise s hodnotou z onOk alebo null pri zrušení. */
  function modal({ title, body, okText = 'Potvrdiť', okClass = 'btn-primary', cancelText = 'Zrušiť', onOk }) {
    return new Promise((resolve) => {
      const root = document.getElementById('modal-root');
      root.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
        <h2 id="m-title">${esc(title)}</h2><div class="m-body">${body}</div>
        <div class="error-text" id="m-err"></div>
        <div class="row end"><button type="button" class="btn" id="m-cancel">${esc(cancelText)}</button>
        <button type="button" class="btn ${okClass}" id="m-ok">${esc(okText)}</button></div></div></div>`;
      const close = (v) => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(v); };
      const ok = async () => {
        const btn = root.querySelector('#m-ok');
        try {
          btn.disabled = true;
          const v = onOk ? await onOk(root) : true;
          if (v === false) { btn.disabled = false; return; }
          close(v === undefined ? true : v);
        } catch (e) { root.querySelector('#m-err').textContent = e.message; btn.disabled = false; }
      };
      const onKey = (e) => {
        if (e.key === 'Escape') close(null);
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.id !== 'm-cancel') { e.preventDefault(); ok(); }
      };
      document.addEventListener('keydown', onKey);
      root.querySelector('#m-cancel').onclick = () => close(null);
      root.querySelector('#m-ok').onclick = ok;
      root.querySelector('.modal-back').addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-back')) close(null); });
      const first = root.querySelector('.m-body input, .m-body textarea, .m-body select') || root.querySelector('#m-ok');
      setTimeout(() => first.focus(), 0);
    });
  }
  const confirmDialog = (title, text, okText, danger) =>
    modal({ title, body: `<p>${esc(text)}</p>`, okText, okClass: danger ? 'btn-danger solid' : 'btn-primary' });

  function handleError(e) {
    if (e.status === 401) { toast('Prihlásenie vypršalo. Prihláste sa znova.', 'error'); showLogin(); return; }
    toast(e.message || 'Nastala chyba.', 'error');
  }

  /** Akcia na serveri s ochranou proti dvojitému kliknutiu. */
  async function act(fn, okMsg) {
    if (S.busy) return null;
    if (S.conn !== 'online') { toast('Nie je spojenie so serverom. Akciu nemožno vykonať.', 'error'); return null; }
    S.busy = true;
    try {
      const r = await fn();
      if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok');
      return r;
    } catch (e) { handleError(e); return null; }
    finally { S.busy = false; }
  }

  function setConn(c) {
    S.conn = c;
    const t = { online: 'Pripojené', connecting: 'Pripája sa…', offline: 'Bez spojenia' }[c];
    $conn.className = 'conn conn-' + c;
    $conn.textContent = t;
    document.querySelectorAll('.needs-online').forEach((b) => { b.disabled = c !== 'online'; });
    if (S.view === 'queue' && S.staff) renderQueue();
  }

  const roomsActive = () => (S.staff ? S.staff.rooms.filter((r) => r.active) : []);
  const roomName = (id) => { const r = S.staff && S.staff.rooms.find((x) => x.id === id); return r ? r.name : ''; };

  function pickRoom() {
    const active = roomsActive();
    if (!active.length) { S.roomId = null; return; }
    if (S.roomId && active.some((r) => r.id === S.roomId)) return;
    if (S.user && S.user.roomId && active.some((r) => r.id === S.user.roomId)) { S.roomId = S.user.roomId; return; }
    const def = Number(lsGet(LS_ROOM));
    S.roomId = active.some((r) => r.id === def) ? def : active[0].id;
  }

  // ---------- štart ----------
  async function boot() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    try {
      const st = await api('/api/setup/status');
      if (st.setupRequired) return showSetup();
      const me = await api('/api/auth/me').catch((e) => { if (e.status === 401) return null; throw e; });
      if (!me) return showLogin();
      S.user = me.user;
      startApp();
    } catch (e) {
      $view.innerHTML = `<div class="auth-wrap card"><h2>Server je nedostupný</h2><p>${esc(e.message)}</p>
        <p class="hint">Skontrolujte, či je server zapnutý a počítač pripojený do siete ambulancie.</p>
        <button class="btn btn-primary" id="retry">Skúsiť znova</button></div>`;
      document.getElementById('retry').onclick = boot;
      setTimeout(boot, 10000);
    }
  }

  function showSetup() {
    stopSocket();
    $topbar.hidden = true;
    $view.innerHTML = `<form class="auth-wrap card stack" id="f">
      <img class="auth-logo" src="adna-logo.png" alt="AdNa s.r.o.">
      <h1>Sestra</h1>
      <div class="sub">Prvotné nastavenie hesla personálu</div>
      <p class="hint">Inštalačný kód vypísal server pri prvom spustení do konzoly a uložil do súboru
        <b>server/data/SETUP-KOD.txt</b> na počítači so serverom.</p>
      <div class="field"><label for="code">Inštalačný kód</label><input type="text" id="code" autocomplete="off" required></div>
      <div class="field"><label for="p1">Nové heslo (aspoň 10 znakov)</label><input type="password" id="p1" autocomplete="new-password" required minlength="10"></div>
      <div class="field"><label for="p2">Zopakujte heslo</label><input type="password" id="p2" autocomplete="new-password" required></div>
      <div class="error-text" id="err"></div>
      <button class="btn btn-primary btn-xl" type="submit">Nastaviť heslo</button>
    </form>`;
    const f = document.getElementById('f');
    f.querySelector('#code').focus();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const err = f.querySelector('#err');
      const p1 = f.querySelector('#p1').value, p2 = f.querySelector('#p2').value;
      if (p1.length < 10) { err.textContent = 'Heslo musí mať aspoň 10 znakov.'; return; }
      if (p1 !== p2) { err.textContent = 'Heslá sa nezhodujú.'; return; }
      try {
        await api('/api/setup', { body: { setupCode: f.querySelector('#code').value, password: p1 } });
        await api('/api/auth/login', { body: { username: 'personal', password: p1, deviceLabel: 'Sestra' } });
        toast('Heslo bolo nastavené.', 'ok');
        boot();
      } catch (e2) { err.textContent = e2.message; }
    };
  }

  function showLogin() {
    stopSocket();
    S.user = null; S.staff = null;
    $topbar.hidden = true;
    $view.innerHTML = `<form class="auth-wrap card stack" id="f">
      <img class="auth-logo" src="adna-logo.png" alt="AdNa s.r.o.">
      <h1>Sestra</h1>
      <div class="sub">Prihlásenie personálu</div>
      <div class="field"><label for="un">Konto</label><input type="text" id="un" autocomplete="username" autocapitalize="none" value="${esc(lsGet(LS_USER) || 'personal')}" required></div>
      <div class="field"><label for="pw">Heslo</label><input type="password" id="pw" autocomplete="current-password" required></div>
      <div class="error-text" id="err"></div>
      <button class="btn btn-primary btn-xl" type="submit" id="login-btn">Prihlásiť sa</button>
    </form>`;
    const f = document.getElementById('f');
    f.querySelector('#pw').focus();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const btn = f.querySelector('#login-btn');
      btn.disabled = true;
      try {
        const un = f.querySelector('#un').value.trim().toLowerCase();
        const r = await api('/api/auth/login', { body: { username: un, password: f.querySelector('#pw').value, deviceLabel: 'Sestra' } });
        lsSet(LS_USER, un);
        S.user = r.user;
        startApp();
      } catch (e2) {
        if (e2.code === 'SETUP_REQUIRED') return showSetup();
        f.querySelector('#err').textContent = e2.message;
        btn.disabled = false;
        f.querySelector('#pw').select();
      }
    };
  }

  function stopSocket() { if (S.socket) { S.socket.stop(); S.socket = null; } }

  function startApp() {
    $topbar.hidden = false;
    document.getElementById('tab-admin').hidden = S.user.role !== 'admin';
    document.getElementById('tab-stats').hidden = S.user.role !== 'admin';
    const isDoc = !!S.user.doctorName;
    document.body.classList.toggle('is-doctor', isDoc);
    document.querySelector('.brand-title').textContent = isDoc ? 'Lekár' : 'Sestra';
    document.getElementById('tab-me').hidden = !isDoc;
    document.getElementById('tab-today').hidden = isDoc || S.user.role === 'admin';
    document.querySelector('.tab[data-view=history]').hidden = isDoc;
    stopSocket();
    $view.innerHTML = '<div class="center-msg">Načítava sa zoznam…</div>';
    S.socket = connect('staff', {
      onStatus: setConn,
      onUnauthorized: () => { toast('Prihlásenie vypršalo. Prihláste sa znova.', 'error'); showLogin(); },
      onMessage: (m) => {
        if (m.type === 'staff.state') {
          const first = !S.staff;
          S.staff = m.state;
          pickRoom();
          if (S.view === 'queue') renderQueue();
          else if (first) go(S.view);
        }
      },
    });
    go(S.view);
  }

  function go(view) {
    S.view = view;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    if (view === 'queue') renderQueue();
    if (view === 'history') renderHistory();
    if (view === 'admin') renderAdmin();
    if (view === 'stats') renderStats();
    if (view === 'me') renderMe();
    if (view === 'today') renderToday();
  }
  document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => go(t.dataset.view); });
  document.getElementById('btn-logout').onclick = async () => {
    const ok = await confirmDialog('Odhlásiť sa?', 'Na tomto počítači bude potrebné znova zadať heslo.', 'Odhlásiť');
    if (!ok) return;
    try { await api('/api/auth/logout', { body: {} }); } catch {}
    showLogin();
  };

  // hodiny v hlavičke
  function tick() {
    const d = new Date();
    document.getElementById('clock-time').textContent = d.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
    document.getElementById('clock-date').textContent = d.toLocaleDateString('sk-SK', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  tick(); setInterval(tick, 15000);

  // ---------- zoznam ----------
  // v2.1: každá ambulancia vidí predvolene svojich pacientov (+ spoločných, napr. z tabletu)
  const showAll = () => lsGet(LS_ALL) === '1';
  const mineFilter = (t) => t.homeRoomId == null || t.homeRoomId === S.roomId;
  const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}` : `${m} min`);
  // v2: poradie = plánovaný čas (ak je zadaný), inak čas príchodu – rovnako ako na serveri
  const orderKey = (t) => t.plannedAt || t.createdAt;
  const byOrder = (a, b) => orderKey(a).localeCompare(orderKey(b)) || a.seq - b.seq;
  /** Odchýlka od plánovaného času v minútach (kladné = meškanie). */
  function plannedBadge(t, now) {
    if (!t.plannedAt) return '<span class="hint">—</span>';
    const late = Math.round((now - Date.parse(t.plannedAt)) / 60000);
    const tol = (S.staff && S.staff.settings.onTimeMinutes) || 0;
    const cls = late > tol ? 'late' : 'ok';
    const txt = late > tol ? `+${late} min` : late < -tol ? `o ${-late} min` : 'teraz';
    return `<b>${esc(fmtTime(t.plannedAt))}</b> <span class="delta ${cls}">${txt}</span>`;
  }
  function printBadge(p) {
    if (!p || !p.status) return '';
    return `<span class="badge b-p-${esc(p.status)}" title="${esc(p.message || '')}">${esc(PRINT_TEXT[p.status] || p.status)}</span>`;
  }

  function renderQueue() {
    const st = S.staff;
    if (!st) { $view.innerHTML = '<div class="center-msg">Načítava sa zoznam…</div>'; return; }
    const off = S.conn !== 'online';
    const dis = off ? 'disabled' : '';
    const active = roomsActive();
    document.getElementById('who').innerHTML = `<b>${esc(S.user.doctorName || S.user.username)}</b>${S.user.roomId ? ' · ' + esc(roomName(S.user.roomId)) : ''}`;
    const all = showAll();
    const mine = (t) => all || mineFilter(t);
    const waiting = st.tickets.filter((t) => t.status === 'waiting' && mine(t)).sort(byOrder);
    const called = st.tickets.filter((t) => t.status === 'called' && (all || t.roomId === S.roomId || mineFilter(t))).sort((a, b) => (b.calledAt || '').localeCompare(a.calledAt || ''));
    const finished = st.tickets.filter((t) => (t.status === 'done' || t.status === 'absent') && (all || t.roomId === S.roomId || mineFilter(t))).sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || ''));
    const nWaitAll = st.tickets.filter((t) => t.status === 'waiting').length;
    const delay = (st.settings.roomDelays || {})[S.roomId];
    const doctor = (st.doctors || {})[S.roomId] || null;
    const printProblems = st.tickets.filter((t) => (t.status === 'waiting' || t.status === 'called') && t.print && (t.print.status === 'failed' || t.print.status === 'unverified'));
    const now = Date.now();
    const def = Number(lsGet(LS_ROOM));

    const alerts = [];
    if (off) alerts.push(`<div class="alert alert-danger" role="alert"><div class="grow"><b>Bez spojenia so serverom.</b> Zobrazený zoznam nemusí byť aktuálny, akcie sú dočasne vypnuté. Spojenie sa obnoví automaticky.</div></div>`);
    // bez kiosku (čísla prideľuje sestra) upozornenie na vypnutú tlač nemá zmysel – ukáže sa, až keď príde číslo z tabletu
    if (!st.settings.printer.enabled && st.tickets.some((t) => t.source !== 'card')) alerts.push(`<div class="alert alert-warn"><div class="grow"><b>Tlač lístkov je vypnutá.</b> Pacienti dostanú číslo len na obrazovke tabletu.${S.user.role === 'admin' ? ' Zapnete ju v Nastaveniach.' : ''}</div></div>`);
    for (const t of printProblems) {
      alerts.push(`<div class="alert ${t.print.status === 'failed' ? 'alert-danger' : 'alert-warn'}" data-print-alert="${t.id}"><div class="grow">
        <b>Lístok ${esc(t.code)}: ${esc(PRINT_TEXT[t.print.status])}.</b> ${esc(t.print.message || '')}</div>
        <button class="btn btn-sm needs-online" data-act="reprint" data-id="${t.id}" ${dis}>Znovu vytlačiť lístok</button></div>`);
    }
    if (st.announcement) alerts.push(`<div class="alert alert-danger" role="status"><div class="grow"><b>📢 Mimoriadny oznam v čakárni:</b> ${esc(st.announcement.text)}
      <span class="hint">(od ${esc(fmtTime(st.announcement.at))})</span></div>
      <button class="btn btn-sm needs-online" data-act="announce-edit" ${dis}>Upraviť</button>
      <button class="btn btn-sm btn-primary needs-online" data-act="announce-clear" ${dis}>Zrušiť oznam</button></div>`);
    if (delay) alerts.push(`<div class="alert alert-warn"><div class="grow"><b>${esc(roomName(S.roomId))}: v čakárni sa zobrazuje meškanie ${esc(fmtMin(delay.minutes))}.</b>
      ${delay.text ? esc(delay.text) + '. ' : ''}Oznam sa zruší sám pri vyvolaní ďalšieho pacienta.</div>
      <button class="btn btn-sm needs-online" data-act="delay-clear" ${dis}>Zrušiť oznam</button></div>`);
    if (st.previousDayOpen && !S.user.doctorName) alerts.push(`<div class="alert alert-info"><div class="grow">Z dňa ${esc(fmtDay(st.previousDayOpen.day))} ostalo
      ${st.previousDayOpen.count} nevybavených čísel. Do dnešného zoznamu sa neprenášajú.</div>
      <button class="btn btn-sm" data-act="open-history" data-day="${esc(st.previousDayOpen.day)}">Zobraziť v histórii</button></div>`);

    const waitRows = waiting.map((t, i) => `<tr data-ticket="${t.id}">
      <td class="code">${esc(t.code)}${all && t.homeRoomName ? `<span class="room-tag">${esc(t.homeRoomName)}</span>` : ''}</td><td class="nw t-plan">${plannedBadge(t, now)}
        <button class="btn btn-sm btn-ghost needs-online" data-act="plan" data-id="${t.id}" ${dis} title="Zmeniť plánovaný čas">${t.plannedAt ? 'Zmeniť' : 'Zadať čas'}</button></td>
      <td class="nw t-arr">${esc(fmtTime(t.createdAt))}</td><td class="nw t-wait">${esc(fmtWait(t.createdAt, now))}</td>
      <td class="t-src">${t.source === 'card' ? '<span class="badge">Od sestry</span>' : printBadge(t.print)}</td>
      <td class="actions"><div class="acts">
        <button class="btn btn-sm btn-primary needs-online" data-act="call" data-id="${t.id}" ${dis}>Vyvolať${i > 0 ? '…' : ''}</button>
        <button class="btn btn-sm needs-online" data-act="absent" data-id="${t.id}" ${dis}>Neprítomný</button>
        ${t.source === 'card' ? '' : `<button class="btn btn-sm btn-ghost needs-online" data-act="reprint" data-id="${t.id}" ${dis} title="Znovu vytlačiť lístok">Tlač</button>`}
      </div></td></tr>`).join('');

    const calledRows = called.map((t) => `<tr data-ticket="${t.id}">
      <td class="code">${esc(t.code)}</td><td class="c-room">${esc(t.roomName || '')}</td><td class="c-time">vyvolaný ${esc(fmtTime(t.calledAt))}</td>
      <td class="c-count">${t.callCount}×</td>
      <td class="actions"><div class="acts">
        <button class="btn btn-sm btn-primary needs-online" data-act="done" data-id="${t.id}" ${dis}>✓ Vybavený</button>
        <button class="btn btn-sm btn-dark needs-online" data-act="recall" data-id="${t.id}" ${dis}>Zopakovať</button>
        <button class="btn btn-sm needs-online" data-act="absent" data-id="${t.id}" ${dis}>Neprítomný</button>
        <button class="btn btn-sm btn-ghost needs-online" data-act="requeue" data-id="${t.id}" ${dis}>Vrátiť</button>
      </div></td></tr>`).join('');

    const finRows = finished.slice(0, 30).map((t) => `<tr data-ticket="${t.id}">
      <td class="code">${esc(t.code)}</td><td><span class="badge b-${t.status}">${esc(STATUS_TEXT[t.status])}</span></td>
      <td>${esc(t.roomName || '')}</td><td>${esc(fmtTime(t.finishedAt))}</td>
      <td class="actions"><button class="btn btn-sm btn-ghost needs-online" data-act="requeue" data-id="${t.id}" ${dis} title="Vrátiť medzi čakajúcich">Vrátiť</button></td></tr>`).join('');

    // ďalší na rade – veľká karta s hlavnou akciou
    const next = waiting[0] || null;
    let heroInfo;
    if (next) {
      const pills = [`<span class="pill">príchod ${esc(fmtTime(next.createdAt))}</span>`, `<span class="pill">čaká ${esc(fmtWait(next.createdAt, now))}</span>`];
      if (next.plannedAt) {
        const late = Math.round((now - Date.parse(next.plannedAt)) / 60000);
        const tol = st.settings.onTimeMinutes || 0;
        pills.push(late > tol ? `<span class="pill late">mešká sa ${esc(fmtMin(late))}</span>` : `<span class="pill ok">v čase</span>`);
      }
      heroInfo = `<div class="hero-kicker">Ďalší na rade</div>
        <div class="hero-main">${next.plannedAt ? 'Termín ' + esc(fmtTime(next.plannedAt)) : 'Bez termínu'}${waiting.length > 1 ? ` · potom ešte ${waiting.length - 1}` : ''}</div>
        <div class="hero-meta">${pills.join('')}</div>`;
    } else {
      heroInfo = `<div class="hero-kicker">Ďalší na rade</div><div class="hero-main">Nikto nečaká</div>
        <div class="hero-meta"><span class="pill">${S.user.doctorName ? 'Pacientov zaraďuje sestra' : 'Pacienta pridáte tlačidlom „+ Pacient“'}</span></div>`;
    }

    // zachovanie pozície posúvania pri prekreslení
    const scroll = window.scrollY;
    const fin = document.querySelector('.fin-wrap');
    const finScroll = fin ? fin.scrollTop : 0;
    // pracovisko: veľký názov ambulancie, kam sa vyvoláva (farba ako na TV: 1. červená, 2. sivá, 3. čierna)
    const ri = Math.max(0, active.findIndex((r) => r.id === S.roomId));
    const roomNow = active[ri];
    const roomNo = roomNow ? ((String(roomNow.name).match(/(\d+)/) || [])[1] || String(ri + 1)) : '–';
    $view.innerHTML = `<div class="dash">
      <div class="a-room stack"><section class="roombar c${(ri % 3) + 1}" aria-label="Pracovisko">
        <div class="rb-id"><div class="rb-num" aria-hidden="true">${esc(roomNo)}</div>
          <div class="rb-text"><div class="rb-kicker">Vyvolávate do</div><div class="rb-name" id="room-name">${roomNow ? esc(roomNow.name) : '⚠ Vyberte pracovisko'}</div></div></div>
        <div class="rb-btns">
          <button class="btn needs-online ${doctor || S.user.doctorName ? '' : 'need'}" id="btn-doctor" ${dis} title="Lekár, ktorého meno sa ukáže na TV pri vyvolaní">${doctor ? '👩‍⚕️ ' + esc(doctor) : S.user.doctorName ? '👩‍⚕️ ' + esc(S.user.doctorName) : '⚠ Zadať lekára'}</button>
          <button class="btn needs-online ${delay ? 'on' : ''}" id="btn-delay" ${dis} title="Oznam do čakárne, že pracovisko mešká (napr. predĺžený výkon)">${delay ? `Meškanie ${fmtMin(delay.minutes)}` : 'Hlásiť meškanie'}</button>
          <button class="btn needs-online ${st.announcement ? 'on' : ''}" id="btn-announce" ${dis} title="Mimoriadny oznam na obrazovke v čakárni">📢 ${st.announcement ? 'Oznam je zapnutý' : 'Mimoriadny oznam'}</button>
        </div>
        <div class="rb-pick">
          <label class="lbl" for="room">Zmeniť pracovisko</label>
          <select id="room">${active.map((r) => `<option value="${r.id}" ${r.id === S.roomId ? 'selected' : ''}>${esc(r.name)}${r.id === def ? ' (predvolená)' : ''}</option>`).join('')}</select>
          <label class="check hint"><input type="checkbox" id="room-def" ${S.roomId === def ? 'checked' : ''}> Predvolená pre tento počítač</label>
          <label class="check hint"><input type="checkbox" id="show-all" ${all ? 'checked' : ''}> Pacienti všetkých pracovísk</label>
        </div>
      </section>
      ${alerts.length ? `<div class="a-alerts">${alerts.join('')}</div>` : ''}</div>

      <section class="hero a-hero" aria-label="Ďalší na rade">
        <div class="hero-tile ${next ? (next.code.length > 3 ? 'long' : '') : 'empty'}">${next ? esc(next.code) : '—'}</div>
        <div class="hero-info">${heroInfo}</div>
        <div class="hero-actions">
          <button class="btn btn-xl btn-call needs-online" id="btn-next" ${off || !waiting.length || !S.roomId ? 'disabled' : ''}>Vyvolať ďalšieho${waiting.length ? ' (' + esc(waiting[0].code) + ')' : ''}</button>
          <button class="btn btn-add needs-online" id="btn-card" ${dis}>+ Pacient</button>
        </div>
      </section>

      <section class="card now a-now"><div class="panel-title"><h2><span class="live-dot" aria-hidden="true"></span>Práve v ambulancii (${called.length})</h2></div>
        ${called.length ? `<table id="tbl-called"><thead><tr><th>Číslo</th><th>Ambulancia</th><th>Vyvolaný</th><th>Počet</th><th></th></tr></thead><tbody>${calledRows}</tbody></table>`
          : '<div class="empty">Momentálne nie je nikto vyvolaný.</div>'}
      </section>

      <section class="card a-waiting"><div class="section-title"><h2>Čakajúci (${waiting.length})</h2><span class="hint">${esc(fmtDay(st.day))}</span></div>
        ${waiting.length ? `<table id="tbl-waiting"><thead><tr><th>Číslo</th><th>Termín</th><th>Príchod</th><th>Čaká</th><th>Lístok</th><th></th></tr></thead><tbody>${waitRows}</tbody></table>`
          : '<div class="empty">Nikto nečaká.</div>'}
      </section>

      <div class="stack a-side">
        <div class="counts">
          <div class="count c-wait"><b id="cnt-waiting">${waiting.length}</b><span>čaká${!all && nWaitAll > waiting.length ? ` (spolu ${nWaitAll})` : ''}</span></div>
          <div class="count"><b>${called.length}</b><span>vyvolaní</span></div>
          <div class="count c-done"><b>${finished.filter((t) => t.status === 'done').length}</b><span>vybavení</span></div>
          <div class="count"><b>${finished.filter((t) => t.status === 'absent').length}</b><span>neprítomní</span></div>
        </div>
        <section class="card"><div class="section-title"><h2>Vybavení a neprítomní</h2></div>
          ${finished.length ? `<div class="fin-wrap"><table id="tbl-finished"><thead><tr><th>Číslo</th><th>Stav</th><th>Ambulancia</th><th>Čas</th><th></th></tr></thead><tbody>${finRows}</tbody></table></div>`
            : '<div class="empty">Zatiaľ nikto.</div>'}
        </section>
      </div></div>`;
    const fin2 = document.querySelector('.fin-wrap');
    if (fin2) fin2.scrollTop = finScroll;
    window.scrollTo(0, scroll);

    const sel = document.getElementById('room');
    if (sel) sel.onchange = () => { S.roomId = Number(sel.value); renderQueue(); };
    const defBox = document.getElementById('room-def');
    if (defBox) defBox.onchange = () => { lsSet(LS_ROOM, defBox.checked ? String(S.roomId) : null); renderQueue(); };
    document.getElementById('btn-card').onclick = () => addCard();
    document.getElementById('btn-delay').onclick = () => reportDelay();
    document.getElementById('btn-announce').onclick = () => announce();
    const isDoc = !!S.user.doctorName;
    document.getElementById('btn-doctor').onclick = isDoc ? () => toast('Vaše meno sa na TV nastaví samo pri prvom vyvolaní.', 'ok') : () => askDoctor(false);
    // povinný údaj na začiatku dňa: bez lekára sa okno nedá zavrieť (lekárske konto sa nastaví samo)
    if (!isDoc && !doctor && !off && S.roomId && !S.doctorAsked && !document.getElementById('modal-root').children.length && !S.askingDoctor) askDoctor(true);
    document.getElementById('show-all').onchange = (e) => { lsSet(LS_ALL, e.target.checked ? '1' : null); renderQueue(); };
    document.getElementById('btn-next').onclick = () => act(
      () => api('/api/staff/call-next', { body: { roomId: S.roomId } }),
      (r) => `Vyvolané ${r.ticket.code} – ${r.ticket.roomName}`);
  }

  // akcie v zozname (delegovanie udalostí)
  $view.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b || !S.staff) return;
    const id = Number(b.dataset.id);
    const t = S.staff.tickets.find((x) => x.id === id);
    const code = t ? t.code : '';
    switch (b.dataset.act) {
      case 'call': return callTicket(t);
      case 'recall': return act(() => api(`/api/staff/tickets/${id}/recall`, { body: {} }), `Vyvolanie ${code} zopakované`);
      case 'done': return act(() => api(`/api/staff/tickets/${id}/done`, { body: {} }), `${code}: Vybavený`);
      case 'absent': return act(() => api(`/api/staff/tickets/${id}/absent`, { body: {} }), `${code}: Neprítomný`);
      case 'requeue': {
        const ok = await confirmDialog('Vrátiť medzi čakajúcich?', `Číslo ${code} sa vráti do zoznamu čakajúcich podľa pôvodného času príchodu${t && t.status === 'called' ? ' a zmizne z obrazovky v čakárni' : ''}.`, 'Vrátiť');
        if (ok) act(() => api(`/api/staff/tickets/${id}/requeue`, { body: {} }), `${code} je opäť medzi čakajúcimi`);
        return;
      }
      case 'reprint': {
        const ok = await confirmDialog('Znovu vytlačiť lístok?', `Vytlačí sa lístok s rovnakým číslom ${code}. Nové číslo sa nevytvorí.`, 'Vytlačiť');
        if (!ok) return;
        const r = await act(() => api(`/api/staff/tickets/${id}/reprint`, { body: {}, timeoutMs: 20000 }));
        if (r) toast(`${code}: ${r.print.message}`, r.print.status === 'ok' ? 'ok' : r.print.status === 'failed' ? 'error' : '');
        return;
      }
      case 'plan': return planTicket(t);
      case 'announce-edit': return announce();
      case 'announce-clear': return act(() => api('/api/staff/announcement', { body: { text: null } }), 'Mimoriadny oznam bol zrušený.');
      case 'delay-clear': return act(() => api(`/api/staff/rooms/${S.roomId}/delay`, { body: { minutes: null } }), 'Oznam o meškaní bol zrušený.');
      case 'open-history': S.historyDay = b.dataset.day; return go('history');
    }
  });

  /** v2.2: lekár, ktorý dnes ordinuje v ambulancii – na TV sa ukáže namiesto názvu ambulancie. */
  async function askDoctor(required) {
    S.askingDoctor = true;
    const list = (S.staff.settings.doctorList || []);
    const cur = (S.staff.doctors || {})[S.roomId] || '';
    try {
      const res = await modal({
        title: required ? `Dobré ráno – kto dnes ordinuje v ambulancii ${roomName(S.roomId)}?` : `Lekár – ${roomName(S.roomId)}`,
        okText: 'Uložiť',
        cancelText: required ? 'Neskôr' : 'Zrušiť',
        body: `<p class="hint">Meno sa ukáže na obrazovke v čakárni pri vyvolaní pacienta. Počas dňa ho môžete kedykoľvek zmeniť tlačidlom s menom lekára.</p>
          <div class="field"><label for="m-doc">Meno a priezvisko lekára (alebo iniciály)</label>
            <input id="m-doc" list="m-doc-list" maxlength="60" value="${esc(cur)}" autocomplete="off" placeholder="napr. MUDr. Ján Novák" autofocus>
            <datalist id="m-doc-list">${list.map((n) => `<option value="${esc(n)}">`).join('')}</datalist></div>
          ${list.length ? `<div class="row" style="flex-wrap:wrap;gap:8px;margin-top:10px">${list.map((n) => `<button type="button" class="btn btn-sm" data-doc="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}`,
        onOk: async (root) => {
          const name = root.querySelector('#m-doc').value.trim();
          if (name.length < 2) throw new Error('Zadajte meno lekára – je to povinný údaj pre dnešný deň.');
          return api(`/api/staff/rooms/${S.roomId}/doctor`, { body: { name } });
        },
      });
      if (res) toast('Lekár bol uložený.', 'ok');
      else if (required) toast('Bez zadaného lekára sa na TV ukáže len názov ambulancie.', 'error');
    } finally { S.askingDoctor = false; S.doctorAsked = true; }
  }
  // výber lekára kliknutím na meno v okne
  document.addEventListener('click', (e) => { const b = e.target.closest('button[data-doc]'); if (b) { const i = document.getElementById('m-doc'); if (i) { i.value = b.dataset.doc; i.focus(); } } });

  /** v2.3: mimoriadny oznam – zobrazí sa na TV v čakárni, kým ho niektorá sestra nezruší. */
  async function announce() {
    const cur = S.staff.announcement;
    const presets = ['Z technických príčin sa ordinovanie oneskoruje. Ďakujeme za pochopenie.',
      'Dnes ordinujeme len do 12:00. Ďakujeme za pochopenie.', 'Prosíme pacientov, aby si pripravili kartičku poistenca.',
      'Lekár bol odvolaný k akútnemu pacientovi. Vrátime sa čo najskôr.'];
    const res = await modal({
      title: '📢 Mimoriadny oznam do čakárne',
      okText: cur ? 'Zmeniť oznam' : 'Zobraziť na TV',
      body: `<p class="hint">Oznam sa ihneď ukáže na obrazovke v čakárni (veľký text a namiesto lišty so správami) a zostane, kým ho niektorá sestra nezruší.</p>
        <div class="field"><label for="m-ann">Text oznamu (max. 300 znakov)</label><textarea id="m-ann" rows="4" maxlength="300" autofocus>${esc(cur ? cur.text : '')}</textarea></div>
        <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:10px">${presets.map((p) => `<button type="button" class="btn btn-sm" style="white-space:normal;text-align:left;max-width:100%;height:auto" data-ann="${esc(p)}">${esc(p)}</button>`).join('')}</div>
        ${cur ? '<div class="row" style="margin-top:14px"><button type="button" class="btn btn-danger" id="m-ann-clear">✕ Odstrániť oznam z TV</button></div>' : ''}`,
      onOk: async (root) => {
        const text = root.querySelector('#m-ann').value.trim();
        // prázdny text pri zapnutom ozname = odstrániť oznam
        if (!text && cur) return api('/api/staff/announcement', { body: { text: null } }).then(() => 'cleared');
        if (!text) throw new Error('Napíšte text oznamu.');
        return api('/api/staff/announcement', { body: { text } });
      },
    });
    if (res === 'cleared') toast('Mimoriadny oznam bol zrušený.', 'ok');
    else if (res) toast('Oznam sa zobrazuje v čakárni.', 'ok');
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#m-ann-clear')) return;
    const i = document.getElementById('m-ann'); if (i) i.value = '';
    document.getElementById('m-ok').click();
  });
  document.addEventListener('click', (e) => { const b = e.target.closest('button[data-ann]'); if (b) { const i = document.getElementById('m-ann'); if (i) { i.value = b.dataset.ann; i.focus(); } } });

  /** v2.1: oznam do čakárne, že pracovisko mešká (napr. predĺžený výkon u pacienta v ambulancii). */
  async function reportDelay() {
    const cur = (S.staff.settings.roomDelays || {})[S.roomId];
    const opts = [15, 30, 45, 60, 75, 90, 120, 150, 180];
    const res = await modal({
      title: `Hlásiť meškanie – ${roomName(S.roomId)}`,
      okText: 'Zobraziť v čakárni',
      body: `<p class="hint">Na obrazovke v čakárni sa pri pacientoch tohto pracoviska ukáže meškanie a oznam s poďakovaním za trpezlivosť.
          Oznam sa <b>zruší sám pri vyvolaní ďalšieho pacienta</b> z tohto pracoviska.</p>
        <div class="row">
          <div class="field"><label for="m-min">Odhadované meškanie</label><select id="m-min">${opts.map((m) => `<option value="${m}" ${cur && cur.minutes === m ? 'selected' : (!cur && m === 60 ? 'selected' : '')}>${fmtMin(m)}</option>`).join('')}</select></div>
          <div class="field" style="flex:1"><label for="m-txt">Dôvod (zobrazí sa v čakárni, nepovinné)</label><input id="m-txt" maxlength="140" value="${esc(cur ? cur.text : 'Predĺžený výkon u pacienta v ambulancii')}"></div>
        </div>`,
      onOk: async (root) => api(`/api/staff/rooms/${S.roomId}/delay`, { body: { minutes: Number(root.querySelector('#m-min').value), text: root.querySelector('#m-txt').value } }),
    });
    if (res) toast('Meškanie sa zobrazuje v čakárni.', 'ok');
  }

  /** v2: sestra pridelí pacientovi číslo alebo písmeno a zaradí ho s plánovaným časom vyšetrenia. */
  async function addCard() {
    const nowHm = new Intl.DateTimeFormat('sk-SK', { timeZone: 'Europe/Bratislava', hour: '2-digit', minute: '2-digit' }).format(new Date());
    const res = await modal({
      title: 'Pridať pacienta',
      okText: 'Zaradiť',
      body: `<div class="row">
          <div class="field"><label for="m-card">Číslo alebo písmeno pacienta</label><input id="m-card" autocomplete="off" autocapitalize="characters" maxlength="6" placeholder="napr. 12, A, K7" autofocus></div>
          <div class="field"><label for="m-time">Čas objednania (z kalendára)</label><input id="m-time" type="time" step="60" value="" required></div>
        </div><p class="hint">Pracovisko: <b>${esc(roomName(S.roomId))}</b>. Podľa času objednania sa počíta poradie a časový sklz (teraz je ${esc(nowHm)}). Pacientovi povedzte (alebo napíšte) pridelené označenie. Na obrazovke v čakárni sa ukáže iba toto označenie a odchýlka od termínu.</p>`,
      onOk: async (root) => {
        if (S.conn !== 'online') throw new Error('Nie je spojenie so serverom.');
        if (!root.querySelector('#m-card').value.trim()) throw new Error('Zadajte číslo alebo písmeno pacienta.');
        if (!root.querySelector('#m-time').value) throw new Error('Zadajte čas objednania z kalendára – podľa neho sa počíta časový sklz.');
        return api('/api/staff/cards', { body: { cardNo: root.querySelector('#m-card').value, plannedTime: root.querySelector('#m-time').value || null, roomId: S.roomId } });
      },
    });
    if (res && res.ticket) toast(`Pacient ${res.ticket.code} zaradený${res.ticket.plannedAt ? ' na ' + fmtTime(res.ticket.plannedAt) : ''}`, 'ok');
  }

  async function planTicket(t) {
    if (!t) return;
    const cur = t.plannedAt ? fmtTime(t.plannedAt) : '';
    const res = await modal({
      title: `Plánovaný čas – ${t.code}`,
      okText: 'Uložiť',
      body: `<div class="field"><label for="m-time">Plánovaný čas vyšetrenia</label><input id="m-time" type="time" step="300" value="${esc(cur)}"></div>
        <p class="hint">Prázdne pole = bez termínu (poradie podľa príchodu).</p>`,
      onOk: async (root) => api(`/api/staff/tickets/${t.id}/planned`, { body: { plannedTime: root.querySelector('#m-time').value || null } }),
    });
    if (res && res.ticket) toast(`${res.ticket.code}: ${res.ticket.plannedAt ? 'termín ' + fmtTime(res.ticket.plannedAt) : 'bez termínu'}`, 'ok');
  }

  async function callTicket(t) {
    if (!t) return;
    if (!S.roomId) { toast('Vyberte ambulanciu.', 'error'); return; }
    const waiting = S.staff.tickets.filter((x) => x.status === 'waiting' && (showAll() || mineFilter(x))).sort(byOrder);
    const outOfOrder = waiting.length && waiting[0].id !== t.id;
    if (!outOfOrder) {
      return act(() => api(`/api/staff/tickets/${t.id}/call`, { body: { roomId: S.roomId } }), (r) => `Vyvolané ${r.ticket.code} – ${r.ticket.roomName}`);
    }
    const rooms = roomsActive();
    const res = await modal({
      title: `Vyvolať ${t.code}`,
      okText: 'Vyvolať',
      body: `${outOfOrder ? `<p class="alert alert-info">Číslo nie je na rade (na rade je ${esc(waiting[0].code)}). Vyvolanie mimo poradia je v poriadku, napr. pre objednaného pacienta.</p>` : ''}
        <div class="field"><label for="m-room">Ambulancia</label><select id="m-room">${rooms.map((r) => `<option value="${r.id}" ${r.id === S.roomId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
        ${outOfOrder ? `<div class="field" style="margin-top:14px"><label for="m-note">Dôvod (nepovinné, vidí len personál)</label><textarea id="m-note" maxlength="200" placeholder="napr. objednaný na 9:30"></textarea></div>` : ''}`,
      onOk: async (root) => {
        if (S.conn !== 'online') throw new Error('Nie je spojenie so serverom.');
        const roomId = Number(root.querySelector('#m-room').value);
        const noteEl = root.querySelector('#m-note');
        try {
          return await api(`/api/staff/tickets/${t.id}/call`, { body: { roomId, note: noteEl ? noteEl.value : undefined } });
        } catch (e) {
          if (e.status === 409) { toast(e.message, 'error'); return null; }
          if (e.status === 401) { showLogin(); return null; }
          throw e;
        }
      },
    });
    if (res && res.ticket) toast(`Vyvolané ${res.ticket.code} – ${res.ticket.roomName}`, 'ok');
  }

  // čas čakania sa obnovuje každých 30 s
  setInterval(() => { if (S.view === 'queue' && S.staff && !document.getElementById('modal-root').children.length) renderQueue(); }, 30000);

  // ---------- história ----------
  const EV_TEXT = { created: 'Registrácia', planned: 'Plánovaný čas', call: 'Vyvolanie', recall: 'Zopakované vyvolanie', done: 'Vybavený', absent: 'Neprítomný',
    requeue: 'Vrátený medzi čakajúcich', print: 'Tlač lístka', reprint: 'Opakovaná tlač', day_closed: 'Ukončenie dňa', display_cleared: 'Vyčistenie obrazovky' };

  async function renderHistory() {
    $view.innerHTML = '<div class="center-msg">Načítava sa história…</div>';
    let days;
    try { days = (await api('/api/staff/days')).days; } catch (e) { handleError(e); $view.innerHTML = `<div class="center-msg">${esc(e.message)}</div>`; return; }
    if (!S.historyDay) S.historyDay = days.length ? days[0].day : (S.staff && S.staff.day);
    $view.innerHTML = `<div class="grid2" style="grid-template-columns:280px minmax(0,1fr)">
      <section class="card"><h2>Dni</h2><div class="daylist">${days.length ? days.map((d) => `<button class="btn ${d.day === S.historyDay ? 'active' : ''}" data-day="${esc(d.day)}">
        <span>${esc(fmtDay(d.day))}</span><span class="hint">${d.total} čísel${(d.waiting + d.called) && d.day !== (S.staff && S.staff.day) ? ` · <span class="open-badge">${d.waiting + d.called} nevybavené</span>` : ''}</span></button>`).join('') : '<div class="empty">Žiadne záznamy.</div>'}</div></section>
      <section class="card" id="hist-detail"><div class="center-msg">Načítava sa…</div></section></div>`;
    $view.querySelectorAll('.daylist button').forEach((b) => { b.onclick = () => { S.historyDay = b.dataset.day; renderHistory(); }; });
    if (!S.historyDay) { document.getElementById('hist-detail').innerHTML = '<div class="empty">Žiadne záznamy.</div>'; return; }
    try {
      const h = await api('/api/staff/history?day=' + encodeURIComponent(S.historyDay));
      const evBy = {};
      for (const e of h.events) (evBy[e.ticketId] = evBy[e.ticketId] || []).push(e);
      const rows = h.tickets.map((t) => `<tr><td class="code">${esc(t.code)}</td><td><span class="badge b-${t.status}">${esc(STATUS_TEXT[t.status])}</span></td>
        <td>${esc(fmtTime(t.createdAt))}</td><td>${esc(t.roomName || '')}</td><td>${printBadge(t.print)}</td>
        <td class="hint">${(evBy[t.id] || []).map((e) => `${esc(fmtTime(e.at))} ${esc(EV_TEXT[e.type] || e.type)}${e.roomName && /call/.test(e.type) ? ' – ' + esc(e.roomName) : ''}${e.note && (e.type === 'call' || e.type === 'day_closed') ? ` <span class="ev-note">(${esc(e.note)})</span>` : ''}`).join('<br>')}</td></tr>`).join('');
      const openPast = h.day !== (S.staff && S.staff.day) ? h.tickets.filter((t) => t.status === 'waiting' || t.status === 'called').length : 0;
      document.getElementById('hist-detail').innerHTML = `<div class="section-title"><h2>${esc(fmtDay(h.day))}</h2>
        <span class="hint">${h.tickets.length} čísel</span></div>
        ${openPast ? `<div class="alert alert-warn"><div class="grow"><b>${openPast} nevybavené čísla</b> z tohto dňa ostali v stave Čaká alebo Vyvolaný.
          Do nového dňa sa neprenášajú. Uzavretím ich označíte ako Neprítomný.</div>
          <button class="btn btn-danger" id="btn-close-past">Uzavrieť nevybavené…</button></div>` : ''}
        ${h.tickets.length ? `<table><thead><tr><th>Číslo</th><th>Stav</th><th>Príchod</th><th>Ambulancia</th><th>Lístok</th><th>Priebeh</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">V tento deň nie sú žiadne čísla.</div>'}`;
      const bc = document.getElementById('btn-close-past');
      if (bc) bc.onclick = () => modal({
        title: 'Uzavrieť nevybavené čísla?', okText: 'Uzavrieť', okClass: 'btn-danger solid',
        body: `<p>${openPast} čísel z ${esc(fmtDay(h.day))} bude označených ako <b>Neprítomný</b>. Záznam o uzavretí ostane v histórii.</p>`,
        onOk: async () => {
          const r = await api('/api/staff/close-past-day', { body: { day: h.day } });
          toast(`Uzavretých čísel: ${r.closed} (označené ako Neprítomný).`, 'ok');
          renderHistory();
        },
      });
    } catch (e) { handleError(e); }
  }

  const KIND_TEXT = { staff: 'Sestra', doctor: 'Lekár', admin: 'Správca' };
  const kindSelect = (cls, cur, id) => `<select ${cls ? `class="${cls}"` : ''} ${id ? `id="${id}"` : ''} aria-label="Typ konta">${Object.entries(KIND_TEXT)
    .map(([k, t]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  const docSelect = (cls, cur, list, id) => {
    const names = [...new Set([...(list || []), ...(cur ? [cur] : [])])];
    return `<select ${cls ? `class="${cls} u-doc"` : 'class="u-doc"'} ${id ? `id="${id}"` : ''} aria-label="Lekár">${names
      .map((n) => `<option value="${esc(n)}" ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  };

  // ---------- dnešné štatistiky (sestra) ----------
  async function renderToday() {
    $view.innerHTML = '<div class="center-msg">Načítava sa…</div>';
    let r;
    try { r = await api('/api/staff/today-stats'); }
    catch (e) { handleError(e); $view.innerHTML = `<div class="alert alert-danger"><div class="grow">${esc(e.message)}</div></div>`; return; }
    if (S.view !== 'today') return;
    const t = r.total;
    $view.innerHTML = `<div class="stack">
      <section class="card"><div class="section-title"><h2>Dnešné štatistiky – ${esc(fmtDay(r.day))}</h2><button class="btn btn-sm" id="btn-today-refresh">Obnoviť</button></div>
        <p class="hint">Len dnešný deň. Údaje sa počítajú z vyvolaných pacientov.</p></section>
      <section class="stats-kpis">
        <div class="stats-kpi"><b>${t.patients}</b><span>vyvolaných pacientov (čaká ešte ${r.waiting})</span></div>
        <div class="stats-kpi"><b>${t.done}</b><span>vybavených · ${t.absent} neprítomných</span></div>
        <div class="stats-kpi"><b>${mins(t.avgWait)}</b><span>priemerné čakanie od príchodu</span></div>
        <div class="stats-kpi"><b class="${t.avgDelay > 15 ? 'bad' : ''}">${t.planned ? mins(t.avgDelay) : '–'}</b><span>priemerné meškanie oproti plánu</span></div>
        <div class="stats-kpi"><b>${pct(t.onTime, t.planned)}</b><span>vyvolaných načas (do 5 min)</span></div>
      </section>
      ${r.rooms.length ? `<section class="card"><h2>Podľa ambulancie</h2><div class="stats-scroll"><table class="stats-table"><thead><tr>
        <th>Ambulancia</th><th class="num">Pacienti</th><th class="num">Vybavení</th><th class="num">Neprítomní</th><th class="num">Ø čakanie</th>
        <th class="num">Ø meškanie</th><th class="num">Max. meškanie</th><th class="num">Načas</th><th class="num">Ø vyšetrenie</th></tr></thead><tbody>
        ${r.rooms.map((d) => `<tr><td class="doc">${esc(d.name)}</td><td class="num">${d.patients}</td><td class="num">${d.done}</td><td class="num">${d.absent}</td>
          <td class="num">${mins(d.avgWait)}</td><td class="num ${d.avgDelay > 15 ? 'bad' : ''}">${d.planned ? mins(d.avgDelay) : '–'}</td>
          <td class="num">${d.planned ? mins(d.maxDelay) : '–'}</td><td class="num">${pct(d.onTime, d.planned)}</td><td class="num">${mins(d.avgExam)}</td></tr>`).join('')}
        </tbody></table></div></section>` : '<section class="card"><div class="empty">Dnes zatiaľ nebol vyvolaný žiadny pacient.</div></section>'}</div>`;
    document.getElementById('btn-today-refresh').onclick = renderToday;
  }

  // ---------- môj prehľad (konto lekára) ----------
  async function renderMe() {
    if (!S.user.doctorName) { $view.innerHTML = '<div class="center-msg">Prehľad je pre lekárske konto.</div>'; return; }
    const today = (S.staff && S.staff.day) || isoDay(new Date());
    if (!S.meTo) S.meTo = today;
    if (!S.meFrom) { const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() - 29); S.meFrom = isoDay(d); }
    $view.innerHTML = `<div class="stack">
      <section class="card stack"><div class="section-title"><h2>Môj prehľad – ${esc(S.user.doctorName)}</h2><span class="hint">Vidíte len svoje údaje</span></div>
        <form class="stats-filter" id="me-form">
          <div class="field"><label for="me-from">Od</label><input type="date" id="me-from" value="${esc(S.meFrom)}" max="${esc(today)}"></div>
          <div class="field"><label for="me-to">Do</label><input type="date" id="me-to" value="${esc(S.meTo)}" max="${esc(today)}"></div>
          <button class="btn btn-primary" type="submit">Zobraziť</button>
          <button class="btn" type="button" data-range="0">Dnes</button>
          <button class="btn" type="button" data-range="6">7 dní</button>
          <button class="btn" type="button" data-range="29">30 dní</button>
        </form></section>
      <div id="me-out"><div class="center-msg">Načítava sa…</div></div></div>`;
    const form = document.getElementById('me-form');
    form.onsubmit = (e) => { e.preventDefault(); S.meFrom = val('me-from'); S.meTo = val('me-to'); renderMe(); };
    form.querySelectorAll('[data-range]').forEach((b) => { b.onclick = () => {
      const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() - Number(b.dataset.range));
      S.meFrom = isoDay(d); S.meTo = today; renderMe();
    }; });
    let r;
    try { r = await api(`/api/staff/my-stats?from=${encodeURIComponent(S.meFrom)}&to=${encodeURIComponent(S.meTo)}`); }
    catch (e) { handleError(e); document.getElementById('me-out').innerHTML = `<div class="alert alert-danger"><div class="grow">${esc(e.message)}</div></div>`; return; }
    const out = document.getElementById('me-out');
    const t = r.summary;
    if (!t) { out.innerHTML = '<section class="card"><div class="empty">V tomto období ste zatiaľ nevyvolali žiadneho pacienta.</div></section>'; return; }
    const c = r.clinic;
    out.innerHTML = `<div class="stack">
      <section class="stats-kpis">
        <div class="stats-kpi"><b>${t.patients}</b><span>vyvolaných pacientov (vybavení ${t.done})</span></div>
        <div class="stats-kpi"><b>${mins(t.avgWait)}</b><span>priemerné čakanie pacienta<br>(celá ambulancia ${mins(c.avgWait)})</span></div>
        <div class="stats-kpi"><b class="${t.avgDelay > 15 ? 'bad' : ''}">${t.planned ? mins(t.avgDelay) : '–'}</b><span>priemerné meškanie oproti plánu<br>(celá ambulancia ${c.planned ? mins(c.avgDelay) : '–'})</span></div>
        <div class="stats-kpi"><b>${pct(t.onTime, t.planned)}</b><span>pacientov vyvolaných načas (do 5 min)</span></div>
        <div class="stats-kpi"><b>${mins(t.avgExam)}</b><span>priemerná dĺžka vyšetrenia</span></div>
      </section>
      <section class="card"><h2>Po dňoch</h2><div class="stats-scroll"><table class="stats-table"><thead><tr>
        <th>Deň</th><th class="num">Pacienti</th><th class="num">Vybavení</th><th class="num">Neprítomní</th><th class="num">Ø čakanie</th>
        <th class="num">Ø meškanie</th><th class="num">Max. meškanie</th><th class="num">Načas</th><th class="num">Ø vyšetrenie</th></tr></thead><tbody>
        ${r.days.map((d) => `<tr><td class="doc">${esc(fmtDay(d.day))}</td><td class="num">${d.patients}</td><td class="num">${d.done}</td><td class="num">${d.absent}</td>
          <td class="num">${mins(d.avgWait)}</td><td class="num ${d.avgDelay > 15 ? 'bad' : ''}">${d.planned ? mins(d.avgDelay) : '–'}</td><td class="num">${d.planned ? mins(d.maxDelay) : '–'}</td>
          <td class="num">${pct(d.onTime, d.planned)}</td><td class="num">${mins(d.avgExam)}</td></tr>`).join('')}</tbody></table></div>
        <p class="hint">Čakanie = od príchodu pacienta po prvé vyvolanie. Meškanie = vyvolanie oproti plánovanému času (ak pacient prišiel neskôr, od príchodu). Vyšetrenie = od vyvolania po „Vybavený“.</p>
      </section>
      ${r.comparison && r.comparison.length > 1 ? `<section class="card"><div class="section-title"><h2>Porovnanie s ostatnými lekármi</h2><span class="hint">Anonymne – mená ostatných lekárov nevidíte</span></div>
        <div class="stats-scroll"><table class="stats-table"><thead><tr><th>Poradie</th><th>Lekár</th><th class="num">Pacienti</th><th class="num">Ø čakanie</th>
          <th class="num">Ø meškanie</th><th class="num">Načas</th><th class="num">Ø vyšetrenie</th></tr></thead><tbody>
          ${r.comparison.map((d) => `<tr class="${d.me ? 'me-row' : ''}"><td class="num">${d.rank}.</td><td class="doc">${esc(d.label)}</td><td class="num">${d.patients}</td>
            <td class="num">${mins(d.avgWait)}</td><td class="num ${d.avgDelay > 15 ? 'bad' : ''}">${d.planned ? mins(d.avgDelay) : '–'}</td>
            <td class="num">${pct(d.onTime, d.planned)}</td><td class="num">${mins(d.avgExam)}</td></tr>`).join('')}</tbody></table></div>
        <p class="hint">Poradie je podľa priemerného meškania (najmenšie prvé). Ostatní lekári sú označení písmenami a neuvádza sa ich ambulancia.</p>
      </section>` : ''}</div>`;
  }

  // ---------- štatistiky lekárov (len správca) ----------
  const isoDay = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Bratislava' }).format(d);
  const mins = (m) => (m == null ? '–' : m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + ' %' : '–');

  async function renderStats() {
    if (S.user.role !== 'admin') { $view.innerHTML = '<div class="center-msg">Štatistiky vidí len správca.</div>'; return; }
    const today = (S.staff && S.staff.day) || isoDay(new Date());
    if (!S.statsTo) S.statsTo = today;
    if (!S.statsFrom) { const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() - 29); S.statsFrom = isoDay(d); }
    $view.innerHTML = `<div class="stack">
      <section class="card stack"><div class="section-title"><h2>Štatistiky lekárov</h2><span class="hint">Vidí len správca</span></div>
        <form class="stats-filter" id="stats-form">
          <div class="field"><label for="st-from">Od</label><input type="date" id="st-from" value="${esc(S.statsFrom)}" max="${esc(today)}"></div>
          <div class="field"><label for="st-to">Do</label><input type="date" id="st-to" value="${esc(S.statsTo)}" max="${esc(today)}"></div>
          <button class="btn btn-primary" type="submit">Zobraziť</button>
          <button class="btn" type="button" data-range="0">Dnes</button>
          <button class="btn" type="button" data-range="6">7 dní</button>
          <button class="btn" type="button" data-range="29">30 dní</button>
          <button class="btn" type="button" data-range="month">Tento mesiac</button>
        </form></section>
      <div id="stats-out"><div class="center-msg">Načítavajú sa štatistiky…</div></div></div>`;
    const form = document.getElementById('stats-form');
    form.onsubmit = (e) => { e.preventDefault(); S.statsFrom = val('st-from'); S.statsTo = val('st-to'); renderStats(); };
    form.querySelectorAll('[data-range]').forEach((b) => { b.onclick = () => {
      const d = new Date(today + 'T12:00:00');
      if (b.dataset.range === 'month') d.setDate(1); else d.setDate(d.getDate() - Number(b.dataset.range));
      S.statsFrom = isoDay(d); S.statsTo = today; renderStats();
    }; });
    let r;
    try { r = await api(`/api/admin/stats?from=${encodeURIComponent(S.statsFrom)}&to=${encodeURIComponent(S.statsTo)}`); }
    catch (e) { handleError(e); document.getElementById('stats-out').innerHTML = `<div class="alert alert-danger"><div class="grow">${esc(e.message)}</div></div>`; return; }
    const t = r.total;
    const out = document.getElementById('stats-out');
    if (!t.patients) { out.innerHTML = '<section class="card"><div class="empty">V tomto období nebol vyvolaný žiadny pacient.</div></section>'; return; }
    const row = (d, cls = '') => `<tr class="${cls}"><td class="doc">${esc(d.doctor)}${d.rooms && d.rooms.length && !cls ? `<div class="hint">${esc(d.rooms.join(', '))}</div>` : ''}</td>
      <td class="num">${d.days}</td><td class="num">${d.patients}</td><td class="num">${d.done}</td><td class="num">${d.absent}${d.open ? ` <span class="hint">(+${d.open} nevyb.)</span>` : ''}</td>
      <td class="num">${mins(d.avgWait)}</td><td class="num">${mins(d.medianWait)}</td>
      <td class="num">${d.planned}</td><td class="num ${d.avgDelay > 15 ? 'bad' : ''}">${d.planned ? mins(d.avgDelay) : '–'}</td><td class="num">${d.planned ? mins(d.maxDelay) : '–'}</td>
      <td class="num">${pct(d.onTime, d.planned)}</td><td class="num ${d.late15 ? 'bad' : ''}">${d.planned ? d.late15 : '–'}</td>
      <td class="num">${mins(d.avgExam)}</td></tr>`;
    out.innerHTML = `<div class="stack">
      <section class="stats-kpis">
        <div class="stats-kpi"><b>${t.patients}</b><span>vyvolaných pacientov</span></div>
        <div class="stats-kpi"><b>${mins(t.avgWait)}</b><span>priemerné čakanie od príchodu</span></div>
        <div class="stats-kpi"><b>${t.planned ? mins(t.avgDelay) : '–'}</b><span>priemerné meškanie oproti plánovanému času</span></div>
        <div class="stats-kpi"><b>${pct(t.onTime, t.planned)}</b><span>pacientov s plánom vyvolaných načas (do 5 min)</span></div>
        <div class="stats-kpi"><b>${mins(t.avgExam)}</b><span>priemerná dĺžka vyšetrenia</span></div>
      </section>
      <section class="card"><div class="stats-scroll"><table class="stats-table"><thead><tr>
        <th>Lekár</th><th class="num">Dni</th><th class="num">Pacienti</th><th class="num">Vybavení</th><th class="num">Neprítomní</th>
        <th class="num">Ø čakanie</th><th class="num">Medián čak.</th>
        <th class="num">S plán. časom</th><th class="num">Ø meškanie</th><th class="num">Max. meškanie</th><th class="num">Načas</th><th class="num">Mešk. &gt; 15 min</th>
        <th class="num">Ø vyšetrenie</th></tr></thead>
        <tbody>${r.doctors.map((d) => row(d)).join('')}${r.doctors.length > 1 ? row({ ...t, doctor: 'Spolu' }, 'total') : ''}</tbody></table></div>
        <p class="hint">Čakanie = od príchodu (lístok/kartička) po prvé vyvolanie. Meškanie = prvé vyvolanie oproti plánovanému času (ak pacient prišiel neskôr, počíta sa od príchodu) – rovnako ako na TV.
          Vyšetrenie = od vyvolania po „Vybavený“. Lekár sa berie z ambulancie, ktorú sestra mala v čase vyvolania nastavenú.
          ${r.doctorDataSince ? `Lekári sa ukladajú od ${esc(fmtDay(r.doctorDataSince))}; staršie vyvolania sú v riadku „Lekár nebol zadaný“.` : 'Pri vyvolaniach zatiaľ nebol zadaný lekár – nastavte ho v Zozname tlačidlom Lekár.'}</p>
      </section></div>`;
  }

  // ---------- nastavenia ----------
  function refreshAdminBadges() {
    const el = document.getElementById('printer-last');
    if (el && S.staff && S.staff.printer.lastStatus) el.textContent = `Posledný stav: ${PRINT_TEXT[S.staff.printer.lastStatus] || S.staff.printer.lastStatus} – ${S.staff.printer.lastMessage || ''}`;
  }

  async function renderAdmin() {
    if (S.user.role !== 'admin') { $view.innerHTML = '<div class="center-msg">Na nastavenia nemáte oprávnenie.</div>'; return; }
    $view.innerHTML = '<div class="center-msg">Načítavajú sa nastavenia…</div>';
    let s, rooms, users;
    try { [s, rooms, users] = await Promise.all([api('/api/admin/settings'), api('/api/admin/rooms').then((r) => r.rooms), api('/api/admin/users').then((r) => r.users)]); }
    catch (e) { handleError(e); return; }
    const p = s.printer;
    $view.innerHTML = `<div class="stack">
      <section class="card"><h2>Ambulancie a pracoviská</h2>
        <table id="tbl-rooms"><thead><tr><th>Názov (zobrazí sa na obrazovke)</th><th style="width:110px">Poradie</th><th style="width:150px">Smer šípky na TV</th><th style="width:110px">Aktívna</th><th></th></tr></thead><tbody>
        ${rooms.map((r) => `<tr data-room="${r.id}"><td><input type="text" class="r-name" value="${esc(r.name)}" maxlength="60" style="width:100%"></td>
          <td><input type="number" class="r-sort" value="${r.sortOrder}" min="0" max="999" style="width:90px"></td>
          <td><select class="r-dir">${[['', 'bez šípky'], ['right', '→ vpravo'], ['left', '← vľavo'], ['straight', '↑ rovno']].map(([v, l]) => `<option value="${v}" ${r.direction === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
          <td><input type="checkbox" class="r-active" ${r.active ? 'checked' : ''} style="width:20px;height:20px"></td>
          <td class="actions"><button class="btn btn-sm btn-primary" data-room-save="${r.id}">Uložiť</button>
          <button class="btn btn-sm btn-danger" data-room-del="${r.id}">Odstrániť</button></td></tr>`).join('')}
        </tbody></table>
        <form class="row" id="f-room" style="margin-top:14px"><input type="text" id="new-room" placeholder="Nová ambulancia, napr. Ambulancia č. 3" maxlength="60" style="flex:1;min-width:240px">
          <button class="btn btn-primary" type="submit">Pridať</button></form>
      </section>

      <section class="card stack" id="sec-users"><h2>Kontá personálu</h2>
        <p class="hint">Každá ambulancia má vlastné konto. Sestra po prihlásení vidí svojich pacientov a „Vyvolať ďalšieho“ volá len z nich.
          Obrazovka v čakárni je spoločná – zobrazí toho, koho ktorá sestra vyvolá ako prvá.</p>
        <p class="hint"><b>Typ konta:</b> Sestra – pridáva a vyvoláva pacientov. Lekár – vyvoláva a vybavuje pacientov, nepridáva ich, vidí „Môj prehľad“ (svoje čakanie a meškanie).
          Správca – navyše Nastavenia a Štatistiky všetkých lekárov.</p>
        <table id="tbl-users"><thead><tr><th>Konto</th><th>Typ</th><th>Lekár</th><th>Pracovisko</th><th>Aktívne</th><th>Nové heslo</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr data-user="${u.id}"><td><b>${esc(u.username)}</b></td>
          <td>${kindSelect('u-kind', u.doctorName ? 'doctor' : u.role === 'admin' ? 'admin' : 'staff')}</td>
          <td>${docSelect('u-doc', u.doctorName, s.doctorList)}</td>
          <td><select class="u-room"><option value="">všetky</option>${rooms.filter((r) => r.active).map((r) => `<option value="${r.id}" ${r.id === u.roomId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></td>
          <td><input type="checkbox" class="u-active" ${u.active ? 'checked' : ''} style="width:20px;height:20px"></td>
          <td><input type="password" class="u-pw" placeholder="ponechať" autocomplete="new-password" style="width:150px"></td>
          <td class="actions"><button class="btn btn-sm btn-primary" data-user-save="${u.id}">Uložiť</button></td></tr>`).join('')}
        </tbody></table>
        <form class="row" id="f-user">
          <input type="text" id="nu-name" placeholder="meno konta, napr. ambulancia1" maxlength="30" autocapitalize="none" style="min-width:220px">
          <select id="nu-room">${rooms.filter((r) => r.active).map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}<option value="">všetky pracoviská</option></select>
          <input type="password" id="nu-pw" placeholder="heslo (aspoň 10 znakov)" autocomplete="new-password">
          ${kindSelect('', 'staff', 'nu-kind')}
          ${docSelect('', null, s.doctorList, 'nu-doc')}
          <button class="btn btn-primary" type="submit">Pridať konto</button></form>
      </section>

      <form class="card stack" id="f-general"><h2>Všeobecné</h2>
        <div class="form-grid">
          <div class="field"><label for="s-name">Názov zariadenia</label><input type="text" id="s-name" value="${esc(s.clinicName)}" maxlength="60"></div>
          <div class="field"><label for="s-prefix">Predpona čísla</label><input type="text" id="s-prefix" value="${esc(s.ticketPrefix)}" maxlength="2"></div>
          <div class="field"><label for="s-secs">Čas zobrazenia čísla na tablete (s)</label><input type="number" id="s-secs" value="${s.ticketDisplaySeconds}" min="5" max="120"></div>
          <div class="field"><label for="s-recent">Počet naposledy vyvolaných na obrazovke</label><input type="number" id="s-recent" value="${s.recentCount}" min="0" max="10"></div>
        </div>
        <div class="field"><label for="s-instr">Pokyn pre pacienta (tablet a lístok)</label><input type="text" id="s-instr" value="${esc(s.ticketInstruction)}" maxlength="120"></div>
        <label class="check"><input type="checkbox" id="s-sound" ${s.soundEnabled ? 'checked' : ''}> Zvukový signál na obrazovke v čakárni</label>
        <div><button class="btn btn-primary" type="submit">Uložiť nastavenia</button></div>
      </form>

      <form class="card stack" id="f-tv"><h2>Obrazovka v čakárni (TV program a správy)</h2>
        <div class="form-grid">
          <div class="field"><label for="tv-queue">Počet čísel „Na rade“</label><input type="number" id="tv-queue" value="${s.queueCount}" min="0" max="15"></div>
          <div class="field"><label for="tv-tol">Tolerancia „načas“ (± min)</label><input type="number" id="tv-tol" value="${s.onTimeMinutes}" min="0" max="30"></div>
        </div>
        <div class="field"><label for="tv-src">Adresa TV prehrávača vo vloženom okne (nepovinné)</label><input type="text" id="tv-src" value="${esc(s.tvSource)}" placeholder="prázdne = TV zónu vyplní samostatné okno prehrávača alebo HDMI vstup">
          <span class="hint">Väčšina TV prehrávačov vloženie do cudzej stránky nepovoľuje – pozri návod k obrazovke.</span></div>
        <div class="field"><label for="tv-doctors">Lekári na výber (jeden na riadok) – sestra vyberie, kto dnes ordinuje</label>
          <textarea id="tv-doctors" rows="5">${esc((s.doctorList || []).join('\n'))}</textarea></div>
        <h3>Hlavička a informácie pre pacientov</h3>
        <div class="form-grid">
          <div class="field"><label for="sc-title">Nadpis</label><input type="text" id="sc-title" maxlength="60" value="${esc(s.screen.title)}"></div>
          <div class="field"><label for="sc-addr">Adresa</label><input type="text" id="sc-addr" maxlength="80" value="${esc(s.screen.address)}"></div>
          <div class="field"><label for="sc-phone">Telefón (červená pilulka)</label><input type="text" id="sc-phone" maxlength="60" value="${esc(s.screen.phone)}"></div>
          <div class="field"><label for="sc-tvlabel">Názov TV v lište</label><input type="text" id="sc-tvlabel" maxlength="40" value="${esc(s.screen.tvLabel)}"></div>
        </div>
        <div class="field"><label for="sc-info">Informácie pre pacientov (jedna na riadok, najviac 6; <code>**slovo**</code> = tučné)</label>
          <textarea id="sc-info" rows="5">${esc((s.screen.info || []).join('\n'))}</textarea></div>
        <div class="form-grid">
          <div class="field"><label for="sc-theme">Sezónna téma</label><select id="sc-theme">
            ${[['auto', 'Automaticky (Vianoce 1. – 31. 12.)'], ['default', 'Vždy základná'], ['christmas', 'Vianoce teraz']].map(([v, t]) => `<option value="${v}" ${s.screen.theme === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
          <div class="field"><label for="sc-city">Počasie – mesto</label><input type="text" id="sc-city" maxlength="40" value="${esc(s.screen.weather.city)}"></div>
          <div class="field"><label for="sc-lat">Zem. šírka</label><input type="number" step="0.01" id="sc-lat" value="${s.screen.weather.lat}"></div>
          <div class="field"><label for="sc-lon">Zem. dĺžka</label><input type="number" step="0.01" id="sc-lon" value="${s.screen.weather.lon}"></div>
        </div>
        <label class="check"><input type="checkbox" id="sc-weather" ${s.screen.weather.enabled ? 'checked' : ''}> Zobrazovať počasie v hlavičke (Open-Meteo)</label>
        <h3>Hlasové hlásenie</h3>
        <label class="check"><input type="checkbox" id="vo-on" ${s.voice.enabled ? 'checked' : ''}> Po zvukovom signáli hlásiť číslo alebo písmeno (napr. „Číslo dvadsaťpäť, prosím, môžete vstúpiť do ambulancie číslo jeden“)</label>
        <label class="check"><input type="checkbox" id="vo-room" ${s.voice.room ? 'checked' : ''}> Hlásiť aj ambulanciu</label>
        <div class="field"><label for="vo-style">Znenie hlásenia</label><select id="vo-style">
          ${[['nahodne', 'Náhodne striedať 12 viet (odporúčané)'], ['kratke', '„Číslo dvadsaťpäť, ambulancia číslo jeden.“'], ['prosimdo', '„…, prosím do ambulancie číslo jeden.“'], ['nechsapacido', '„…, nech sa páči do ambulancie číslo jeden.“'], ['prosim', '„…, prosím, môžete vstúpiť do ambulancie číslo jeden.“'], ['nechsapaci', '„…, nech sa páči, vstúpte do ambulancie číslo jeden.“'], ['pokracujte', '„…, prosím, pokračujte do ambulancie číslo jeden.“'], ['prid', '„…, prosím, príďte do ambulancie číslo jeden.“'], ['cakame', '„…, čakáme na vás v ambulancii číslo jeden.“'], ['narade', '„…, ste na rade. Prosím, vstúpte do ambulancie číslo jeden.“'], ['ocakava', '„…, ste na rade. Ambulancia číslo jeden vás očakáva.“'], ['dakujeme', '„…, ďakujeme za trpezlivosť, nech sa páči do ambulancie číslo jeden.“'], ['dobryden', '„…, dobrý deň, prosím, môžete vstúpiť do ambulancie číslo jeden.“']].map(([v, t]) => `<option value="${v}" ${(s.voice.style || 'nahodne') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="field" style="max-width:320px"><label for="vo-rate">Rýchlosť reči</label><select id="vo-rate">
          ${[[0.8, 'pomalšie'], [0.9, 'pokojne (odporúčané)'], [1, 'normálne'], [1.1, 'rýchlejšie']].map(([v, t]) => `<option value="${v}" ${Number(s.voice.rate) === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <span class="hint">Hlas poskytuje prehliadač na obrazovke (Microsoft Edge: Viktória/Lukáš). Ak chýba, TV ukáže štítok „Chýba slovenský hlas“.</span></div>
        <h3>Lišta správ</h3>
        <label class="check"><input type="checkbox" id="tv-news" ${s.news.enabled ? 'checked' : ''}> Zobrazovať informačnú lištu so správami</label>
        <div class="field"><label for="tv-feeds">Zdroje správ (RSS) – jeden na riadok v tvare <code>Názov | štítok | adresa</code> (štítok napr. Slovensko, Svet, Košice, Zdravie)</label>
          <textarea id="tv-feeds" rows="8" style="font-family:monospace">${esc(s.news.feeds.map((f) => [f.name, f.tag || '', f.url].join(' | ')).join('\n'))}</textarea></div>
        <div class="field"><label for="tv-excl">Nezobrazovať titulky obsahujúce (oddelené čiarkou)</label><input type="text" id="tv-excl" value="${esc((s.news.exclude || []).join(', '))}"></div>
        <div class="row"><button class="btn btn-primary" type="submit">Uložiť obrazovku</button>
          <button class="btn" type="button" id="tv-news-check">Overiť zdroje správ</button></div>
        <div class="hint" id="tv-news-last"></div>
      </form>

      <form class="card stack" id="f-printer"><h2>Tlačiareň lístkov (sieťová ESC/POS)</h2>
        <p class="hint">Server posiela lístok priamo na sieťovú termálnu tlačiareň s podporou ESC/POS (TCP, zvyčajne port 9100). Tlačiareň musí mať pevnú IP adresu.</p>
        <label class="check"><input type="checkbox" id="p-enabled" ${p.enabled ? 'checked' : ''}> Tlačiť lístky</label>
        <div class="form-grid">
          <div class="field"><label for="p-host">IP adresa tlačiarne</label><input type="text" id="p-host" value="${esc(p.host)}" placeholder="192.168.1.50"></div>
          <div class="field"><label for="p-port">Port</label><input type="number" id="p-port" value="${p.port}" min="1" max="65535"></div>
          <div class="field"><label for="p-enc">Znaky</label><select id="p-enc">
            <option value="ascii" ${p.encoding === 'ascii' ? 'selected' : ''}>Bez diakritiky (funguje na každej tlačiarni)</option>
            <option value="cp852" ${p.encoding === 'cp852' ? 'selected' : ''}>S diakritikou – CP852 (podľa modelu)</option></select></div>
          <div class="field"><label for="p-cp">Číslo kódovej stránky CP852</label><input type="number" id="p-cp" value="${p.codePage}" min="0" max="255"><span class="hint">Epson: 18. Pozrite manuál tlačiarne.</span></div>
        </div>
        <div class="field"><label for="p-footer">Pätička lístka (nepovinné)</label><input type="text" id="p-footer" value="${esc(p.footer)}" maxlength="120"></div>
        <label class="check"><input type="checkbox" id="p-cut" ${p.cut ? 'checked' : ''}> Orezať papier po tlači</label>
        <label class="check"><input type="checkbox" id="p-status" ${p.statusCheck ? 'checked' : ''}> Zisťovať stav tlačiarne (papier, kryt) – DLE EOT</label>
        <div class="row"><button class="btn btn-primary" type="submit">Uložiť tlačiareň</button>
          <button class="btn" type="button" id="p-check">Overiť tlačiareň</button>
          <button class="btn" type="button" id="p-test">Skúšobná tlač</button></div>
        <div class="hint" id="printer-last"></div>
      </form>

      <form class="card stack" id="f-pw"><h2>Zmena hesla personálu</h2>
        <div class="form-grid">
          <div class="field"><label for="pw-cur">Súčasné heslo</label><input type="password" id="pw-cur" autocomplete="current-password"></div>
          <div class="field"><label for="pw-new">Nové heslo (aspoň 10 znakov)</label><input type="password" id="pw-new" autocomplete="new-password"></div>
          <div class="field"><label for="pw-new2">Zopakujte nové heslo</label><input type="password" id="pw-new2" autocomplete="new-password"></div>
        </div>
        <p class="hint">Po zmene hesla sa odhlásia všetky ostatné počítače.</p>
        <div><button class="btn btn-primary" type="submit">Zmeniť heslo</button></div>
      </form>

      <section class="card stack"><h2>Ukončenie dňa a údaje</h2>
        <p>Ukončenie dňa označí všetky dnešné čakajúce a vyvolané čísla ako <b>Neprítomný</b> a vyčistí obrazovku v čakárni.
          Číslovanie pokračuje – už vydané čísla sa dnes nezopakujú. Nový deň (od polnoci) začína automaticky od A001.</p>
        <div class="row"><button class="btn btn-danger" id="btn-close-day">Ukončiť deň…</button></div>
        <p>Vymazanie údajov je nevratné. Zvoľte rozsah: história (všetky dni okrem dneška) alebo všetky čísla vrátane dneška.</p>
        <div class="row"><button class="btn btn-danger" id="btn-purge">Vymazať údaje…</button></div>
      </section>
    </div>`;
    refreshAdminBadges();

    const saveSettings = async (patch, msg) => {
      try { await api('/api/admin/settings', { method: 'PUT', body: patch }); toast(msg, 'ok'); }
      catch (e) { handleError(e); }
    };
    document.getElementById('f-general').onsubmit = (e) => {
      e.preventDefault();
      saveSettings({
        clinicName: val('s-name'), ticketPrefix: val('s-prefix'), ticketDisplaySeconds: Number(val('s-secs')),
        recentCount: Number(val('s-recent')), ticketInstruction: val('s-instr'), soundEnabled: chk('s-sound'),
      }, 'Nastavenia boli uložené.');
    };
    const printerPatch = () => ({ printer: {
      enabled: chk('p-enabled'), host: val('p-host'), port: Number(val('p-port')), encoding: val('p-enc'),
      codePage: Number(val('p-cp')), footer: val('p-footer'), cut: chk('p-cut'), statusCheck: chk('p-status') } });
    document.getElementById('f-printer').onsubmit = (e) => { e.preventDefault(); saveSettings(printerPatch(), 'Nastavenia tlačiarne boli uložené.'); };
    const printerTest = async (print) => {
      try {
        await api('/api/admin/settings', { method: 'PUT', body: printerPatch() });
        const r = await api('/api/admin/printer/test', { body: { print }, timeoutMs: 20000 });
        toast(r.message, r.status === 'ok' ? 'ok' : r.status === 'failed' ? 'error' : '');
        document.getElementById('printer-last').textContent = `Výsledok: ${PRINT_TEXT[r.status] || r.status} – ${r.message}`;
      } catch (e) { handleError(e); }
    };
    document.getElementById('f-tv').onsubmit = (e) => {
      e.preventDefault();
      const feeds = val('tv-feeds').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const p = l.split('|').map((x) => x.trim());
        if (p.length >= 3) return { name: p[0], tag: p[1], url: p.slice(2).join('|') };
        return p.length === 2 ? { name: p[0], url: p[1] } : { name: l, url: l };
      });
      saveSettings({ doctorList: val('tv-doctors').split('\n').map((l) => l.trim()).filter(Boolean), queueCount: Number(val('tv-queue')), onTimeMinutes: Number(val('tv-tol')), tvSource: val('tv-src'),
        voice: { enabled: chk('vo-on'), room: chk('vo-room'), rate: Number(val('vo-rate')), style: val('vo-style') },
        screen: { title: val('sc-title'), address: val('sc-addr'), phone: val('sc-phone'), tvLabel: val('sc-tvlabel'), theme: val('sc-theme'),
          info: val('sc-info').split('\n').map((l) => l.trim()).filter(Boolean),
          weather: { enabled: chk('sc-weather'), city: val('sc-city'), lat: Number(val('sc-lat')), lon: Number(val('sc-lon')) } },
        news: { enabled: chk('tv-news'), feeds, exclude: val('tv-excl').split(',').map((w) => w.trim()).filter(Boolean) } }, 'Nastavenia obrazovky boli uložené.');
    };
    document.getElementById('tv-news-check').onclick = async () => {
      const out = document.getElementById('tv-news-last');
      out.textContent = 'Overujem zdroje…';
      try {
        const r = await api('/api/admin/news/refresh', { body: {}, timeoutMs: 30000 });
        out.innerHTML = `Na lište: ${r.items} titulkov. ` + r.feeds.map((f) => f.ok ? `✓ ${esc(f.name)} (${f.items})` : `⚠ ${esc(f.name)}: ${esc(f.error || 'nedostupný')}`).join(' · ');
      } catch (e2) { out.textContent = ''; handleError(e2); }
    };
    document.getElementById('p-check').onclick = () => printerTest(false);
    document.getElementById('p-test').onclick = () => printerTest(true);

    document.getElementById('f-user').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/admin/users', { body: { username: val('nu-name'), password: val('nu-pw'), roomId: val('nu-room') ? Number(val('nu-room')) : null, role: val('nu-kind') === 'admin' ? 'admin' : 'staff',
          doctorName: val('nu-kind') === 'doctor' ? val('nu-doc') : null } });
        toast('Konto bolo vytvorené.', 'ok'); renderAdmin();
      } catch (e2) { handleError(e2); }
    };
    $view.querySelectorAll('[data-user-save]').forEach((b) => { b.onclick = async () => {
      const tr = b.closest('tr');
      const body = { roomId: tr.querySelector('.u-room').value ? Number(tr.querySelector('.u-room').value) : null,
        role: tr.querySelector('.u-kind').value === 'admin' ? 'admin' : 'staff', active: tr.querySelector('.u-active').checked,
        doctorName: tr.querySelector('.u-kind').value === 'doctor' ? tr.querySelector('.u-doc').value : null };
      const pw = tr.querySelector('.u-pw').value; if (pw) body.password = pw;
      try { await api('/api/admin/users/' + b.dataset.userSave, { method: 'PUT', body }); toast('Konto bolo uložené.', 'ok'); renderAdmin(); } catch (e2) { handleError(e2); }
    }; });
    // výber lekára má zmysel len pri type „Lekár“
    const syncDoc = (kindEl, docEl) => { const f = () => { docEl.hidden = kindEl.value !== 'doctor'; }; kindEl.onchange = f; f(); };
    $view.querySelectorAll('#tbl-users tr[data-user]').forEach((tr) => syncDoc(tr.querySelector('.u-kind'), tr.querySelector('.u-doc')));
    syncDoc(document.getElementById('nu-kind'), document.getElementById('nu-doc'));
    document.getElementById('f-room').onsubmit = async (e) => {
      e.preventDefault();
      const name = val('new-room');
      if (!name) return;
      try { await api('/api/admin/rooms', { body: { name } }); toast('Ambulancia bola pridaná.', 'ok'); renderAdmin(); } catch (e2) { handleError(e2); }
    };
    $view.querySelectorAll('[data-room-save]').forEach((b) => { b.onclick = async () => {
      const tr = b.closest('tr');
      try {
        await api('/api/admin/rooms/' + b.dataset.roomSave, { method: 'PUT', body: {
          name: tr.querySelector('.r-name').value, sortOrder: Number(tr.querySelector('.r-sort').value), active: tr.querySelector('.r-active').checked,
          direction: tr.querySelector('.r-dir').value } });
        toast('Ambulancia bola uložená.', 'ok');
      } catch (e) { handleError(e); }
    }; });
    $view.querySelectorAll('[data-room-del]').forEach((b) => { b.onclick = async () => {
      const name = b.closest('tr').querySelector('.r-name').value;
      const ok = await confirmDialog('Odstrániť ambulanciu?', `Ambulancia „${name}“ sa odstráni. Ak je použitá v histórii, iba sa deaktivuje.`, 'Odstrániť', true);
      if (!ok) return;
      try {
        const r = await api('/api/admin/rooms/' + b.dataset.roomDel, { method: 'DELETE' });
        toast(r.deactivated ? 'Ambulancia je v histórii – bola deaktivovaná.' : 'Ambulancia bola odstránená.', 'ok');
        renderAdmin();
      } catch (e) { handleError(e); }
    }; });

    document.getElementById('f-pw').onsubmit = async (e) => {
      e.preventDefault();
      if (val('pw-new') !== val('pw-new2')) { toast('Nové heslá sa nezhodujú.', 'error'); return; }
      try {
        await api('/api/admin/password', { body: { currentPassword: val('pw-cur'), newPassword: val('pw-new') } });
        toast('Heslo bolo zmenené.', 'ok');
        ['pw-cur', 'pw-new', 'pw-new2'].forEach((i) => { document.getElementById(i).value = ''; });
      } catch (e2) { handleError(e2); }
    };

    document.getElementById('btn-close-day').onclick = () => modal({
      title: 'Ukončiť deň?', okText: 'Ukončiť deň', okClass: 'btn-danger solid',
      body: `<p>Všetky dnešné čakajúce a vyvolané čísla (${S.staff ? S.staff.counts.waiting + S.staff.counts.called : '?'}) budú označené ako Neprítomný a obrazovka v čakárni sa vyčistí.</p>
        <div class="field"><label for="m-confirm">Pre potvrdenie napíšte UKONČIŤ</label><input type="text" id="m-confirm" autocomplete="off"></div>`,
      onOk: async (root) => {
        const r = await api('/api/admin/close-day', { body: { confirm: root.querySelector('#m-confirm').value.trim().toUpperCase() } });
        toast(`Deň bol ukončený (${r.closed} čísel označených ako Neprítomný).`, 'ok');
      },
    });
    document.getElementById('btn-purge').onclick = () => modal({
      title: 'Vymazať údaje?', okText: 'Natrvalo vymazať', okClass: 'btn-danger solid',
      body: `<div class="field"><label for="m-scope">Rozsah</label><select id="m-scope">
          <option value="history">História – všetky dni okrem dneška</option><option value="all">Všetko – vrátane dnešného zoznamu</option></select></div>
        <div class="field" style="margin-top:12px"><label for="m-pw">Heslo personálu</label><input type="password" id="m-pw" autocomplete="current-password"></div>
        <div class="field" style="margin-top:12px"><label for="m-confirm">Pre potvrdenie napíšte VYMAZAŤ</label><input type="text" id="m-confirm" autocomplete="off"></div>
        <p class="hint">Vymazanie je nevratné.</p>`,
      onOk: async (root) => {
        const r = await api('/api/admin/purge', { body: { scope: root.querySelector('#m-scope').value, password: root.querySelector('#m-pw').value,
          confirm: root.querySelector('#m-confirm').value.trim().toUpperCase() } });
        toast(`Vymazaných čísel: ${r.deleted}.`, 'ok');
      },
    });
  }
  const val = (id) => document.getElementById(id).value.trim();
  const chk = (id) => document.getElementById(id).checked;

  boot();
})();
