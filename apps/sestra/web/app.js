// AdNa – aplikácia pre sestru. Bez závislostí, používa /shared/adna-client.js (window.AdNa).
(function () {
  'use strict';
  const { api, connect, esc, fmtTime, fmtDateTime, fmtDay, fmtWait, STATUS_TEXT, PRINT_TEXT } = window.AdNa;

  const POK = window.AdNaPokladnica;   // 2026-11-27: platba pacienta a doklad VRP2 (pokladnica.js)
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
  const LS_POHLAD = 'adna-pohlad-';
  function pohladGet() {
    const v = lsGet(LS_POHLAD + S.user.username);
    if (v === 'nurse' || v === 'doctor' || v === 'both') return v;
    return S.user.doctorName ? 'doctor' : S.user.role === 'admin' ? 'both' : 'nurse';
  }
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
  // 2026-11-17 (Pali): ambulancia, v ktorej dnes neordinuje nikto, sa nezobrazuje na TV ani vo výbere ambulancie
  const isClosed = (id) => !!(S.staff && (S.staff.roomsClosed || []).includes(id));
  const roomsOpen = (keepId) => roomsActive().filter((r) => !isClosed(r.id) || r.id === keepId);
  const roomName = (id) => { const r = S.staff && S.staff.rooms.find((x) => x.id === id); return r ? r.name : ''; };
  // 2026-11-24 (Pali): každá ambulancia má vlastnú stálu farbu – podľa čísla v názve (Ambulancia č. 2 → 2), inak podľa poradia
  const roomColor = (id) => {
    if (id == null || !S.staff) return 'any';
    const rooms = S.staff.rooms || [], i = rooms.findIndex((x) => x.id === id);
    if (i < 0) return 'any';
    const n = Number((String(rooms[i].name).match(/(\d+)/) || [])[1]) || i + 1;
    return 'rc' + (((n - 1) % 4) + 1);
  };
  // názvy ambulancií v texte (História → Priebeh) farebne; text je už ošetrený cez esc()
  const ambColorText = (html) => {
    const rooms = ((S.staff && S.staff.rooms) || []).slice().sort((x, y) => String(y.name).length - String(x.name).length);
    if (!rooms.length) return html;
    const map = new Map(rooms.map((r) => [esc(r.name), roomColor(r.id)]));
    const re = new RegExp('(' + [...map.keys()].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?!\\d)', 'g');
    return html.replace(re, (m) => `<b class="amb-txt ${map.get(m)}">${m}</b>`);
  };
  const ambPill = (id, name) => (name ? `<span class="amb-pill ${roomColor(id)}">${esc(name)}</span>` : '<span class="amb-pill any">Ktorákoľvek</span>');

  function pickRoom() {
    const active = roomsActive();
    if (!active.length) { S.roomId = null; return; }
    if (S.roomId && active.some((r) => r.id === S.roomId)) return;
    const open = active.filter((r) => !isClosed(r.id));
    if (S.user && S.user.roomId && open.some((r) => r.id === S.user.roomId)) { S.roomId = S.user.roomId; return; }
    const def0 = Number(lsGet(LS_ROOM));
    if (open.some((r) => r.id === def0)) { S.roomId = def0; return; }
    if (open.length) { S.roomId = open[0].id; return; }
    if (S.user && S.user.roomId && active.some((r) => r.id === S.user.roomId)) { S.roomId = S.user.roomId; return; }
    const def = Number(lsGet(LS_ROOM));
    S.roomId = active.some((r) => r.id === def) ? def : active[0].id;
  }

  // ---------- heslá: tlačidlo „zobraziť heslo“ pri každom poli hesla ----------
  function enhancePasswords(root) {
    root.querySelectorAll('input[type=password]:not([data-pwt])').forEach((inp) => {
      inp.dataset.pwt = '1';
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn btn-sm btn-ghost pw-toggle'; b.textContent = '👁 Zobraziť';
      b.setAttribute('aria-label', 'Zobraziť heslo'); b.setAttribute('aria-pressed', 'false');
      b.onclick = () => {
        const show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        b.textContent = show ? '🙈 Skryť' : '👁 Zobraziť';
        b.setAttribute('aria-pressed', String(show));
        inp.focus();
      };
      inp.insertAdjacentElement('afterend', b);
    });
  }
  new MutationObserver(() => enhancePasswords(document.body)).observe(document.body, { childList: true, subtree: true });
  /** Meno konta: malé písmená bez diakritiky a medzier (opravuje sa počas písania). */
  const cleanUsername = (v) => String(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9._-]/g, '').slice(0, 30);

  // ---------- hromadné založenie kont (správca) ----------
  /** Náhodné heslo bez zameniteľných znakov (0/O, 1/l/I), generuje sa v prehliadači – nikam sa neposiela okrem servera. */
  function randomPassword(len = 12) {
    const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const a = new Uint32Array(len); crypto.getRandomValues(a);
    return Array.from(a, (x) => abc[x % abc.length]).join('');
  }
  /** Priezvisko lekára → meno konta, napr. „MUDr. Veronika Roškovičová, PhD.“ → „roskovicova“. */
  const surnameLogin = (full) => {
    const parts = String(full).split(',')[0].replace(/\b(MUDr|MVDr|Mgr|Bc|Ing|doc|prof|PhD|MHA|MPH)\.?/gi, ' ').trim().split(/\s+/);
    return cleanUsername(parts[parts.length - 1] || '');
  };
  async function bulkUsers(users, rooms, doctors, nurses = []) {
    const taken = new Set(users.map((u) => u.username));
    const plan = [];
    const add = (p) => { if (p.username.length >= 3 && !taken.has(p.username)) { taken.add(p.username); plan.push(p); } };
    // sestry len pre ambulancie (nie napr. USG pracovisko)
    rooms.filter((r) => /ambulancia/i.test(r.name)).forEach((r, i) => { const n = (String(r.name).match(/(\d+)/) || [])[1] || String(i + 1);
      add({ username: 'ambulancia' + n, kind: 'Sestra', roomId: r.id, where: r.name, doctorName: null }); });
    const hasDoc = new Set(users.map((u) => u.doctorName).filter(Boolean));
    doctors.filter((d) => !hasDoc.has(d)).forEach((d) => add({ username: surnameLogin(d), kind: 'Lekár', roomId: null, where: 'všetky', doctorName: d }));
    // 2026-11-24 (Pali): osobné kontá sestier podľa priezviska – štatistiky sa viažu na sestru, nie na ambulanciu
    const hasNurse = new Set(users.map((u) => u.nurseName).filter(Boolean));
    nurses.filter((n) => !hasNurse.has(n)).forEach((n) => add({ username: surnameLogin(n), kind: 'Sestra (osobné)', roomId: null, where: 'všetky', nurseName: n }));
    // 2026-11-17: kontá lekárov bez hesla (založila ich aktualizácia 16. 11.) dostanú heslo tiež – predtým sa preskočili
    users.filter((u) => u.noPassword && u.active).forEach((u) => plan.push({ username: u.username, kind: u.doctorName ? 'Lekár' : u.nurseName ? 'Sestra (osobné)' : 'Sestra', roomId: u.roomId,
      where: u.roomName || 'všetky', doctorName: u.doctorName, nurseName: u.nurseName, existingId: u.id }));
    if (!plan.length) { toast('Všetky kontá už existujú a majú heslo.', 'ok'); return; }
    const ok = await modal({
      title: `Založiť ${plan.length} kont?`, okText: 'Založiť kontá',
      body: `<table><thead><tr><th>Konto</th><th>Typ</th><th>Meno / pracovisko</th></tr></thead><tbody>
        ${plan.map((p) => `<tr><td><b>${esc(p.username)}</b>${p.existingId ? ' <span class="hint">(už existuje, dostane heslo)</span>' : ''}</td><td>${p.kind}</td><td>${esc(p.doctorName || p.nurseName || p.where)}</td></tr>`).join('')}</tbody></table>
        <p class="hint">Heslá sa vygenerujú náhodne a zobrazia sa <b>len raz</b> hneď po založení – vytlačte si ich alebo odpíšte. Neskôr sa dajú len zmeniť (Nové heslo).</p>`,
    });
    if (!ok) return;
    const done = [];
    for (const p of plan) {
      const password = randomPassword();
      try {
        if (p.existingId) await api('/api/admin/users/' + p.existingId, { method: 'PUT', body: { password } });
        else await api('/api/admin/users', { body: { username: p.username, password, roomId: p.roomId, role: 'staff', doctorName: p.doctorName || null, nurseName: p.nurseName || null } });
        done.push({ ...p, password });
      } catch (e) { done.push({ ...p, error: e.message }); }
    }
    const tableHtml = `<table><thead><tr><th>Konto</th><th>Heslo</th><th>Typ</th><th>Meno / pracovisko</th></tr></thead><tbody>
        ${done.map((p) => `<tr><td><b>${esc(p.username)}</b></td><td>${p.error ? `<span class="bad">⚠ ${esc(p.error)}</span>` : `<code style="font-size:18px">${esc(p.password)}</code>`}</td>
          <td>${p.kind}</td><td>${esc(p.doctorName || p.nurseName || p.where)}</td></tr>`).join('')}</tbody></table>`;
    const printIt = () => {
      // vytlačí sa len tabuľka s heslami (v novom okne), nie celá aplikácia
      const w = window.open('', '_blank', 'width=800,height=900');
      if (!w) { toast('Prehliadač zablokoval okno na tlač – heslá si odpíšte.', 'error'); return; }
      w.document.write(`<!doctype html><meta charset="utf-8"><title>AdNa – kontá</title><style>body{font:16px system-ui;padding:24px}
        table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:8px;text-align:left}code{font-size:18px}</style>
        <h2>Vyvolávací systém AdNa – prihlasovacie údaje</h2><p>${esc(location.origin)}/sestra</p>${tableHtml}`);
      w.document.close(); w.focus(); w.print();
    };
    const shown = modal({
      title: 'Kontá sú založené – heslá', okText: 'Mám ich zapísané', cancelText: 'Zavrieť',
      body: `<div>${tableHtml}</div>
        <div class="row" style="margin-top:12px"><button type="button" class="btn" id="bulk-print-btn">🖨 Vytlačiť heslá</button></div>
        <p class="hint">Adresa: ${esc(location.origin)}/sestra · Heslá sa už znova nezobrazia.</p>`,
    });
    document.getElementById('bulk-print-btn').onclick = printIt;
    await shown;
    renderAdmin();
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
        await api('/api/auth/login', { body: { username: 'admin', password: p1, deviceLabel: 'Sestra' } });
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
      <div class="field"><label for="un">Konto</label><input type="text" id="un" autocomplete="username" autocapitalize="none" value="${esc(lsGet(LS_USER) || 'admin')}" required></div>
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
        // meno konta bez diakritiky a veľkých písmen („Czetöová“ → czetoova), rovnako to robí server
        const un = f.querySelector('#un').value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
        const r = await api('/api/auth/login', { body: { username: un, password: f.querySelector('#pw').value, deviceLabel: 'Sestra' } });
        lsSet(LS_USER, un);
        S.user = r.user;
        startApp();
      } catch (e2) {
        if (e2.code === 'SETUP_REQUIRED') return showSetup();
        f.querySelector('#err').textContent = e2.status === 401
          ? `${e2.message} Skontrolujte aj pole Konto – prihlasujete sa ako „${f.querySelector('#un').value.trim()}“.`
          : e2.message;
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
    document.getElementById('tab-me').hidden = !isDoc && !S.user.nurseName;   // osobné konto lekára alebo sestry
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
          loadReceipts();
          if (S.view === 'queue') renderQueue();
          else if (first) go(S.view);
          else liveStatsSoon();
        }
      },
    });
    go(S.view);
  }

  // 2026-11-27: „Doklady na doriešenie“ – načíta sa pri každej zmene stavu, len keď sú platby zapnuté alebo niečo čaká
  const billingOn = () => !!(S.staff && S.staff.billing && S.staff.billing.enabled);
  const payOf = (t) => (S.staff && S.staff.billing && S.staff.billing.payments[t.id]) || null;
  const payCtx = { toast, handleError, modal, confirm: (...a) => confirmDialog(...a) };
  let receiptsBusy = false;
  async function loadReceipts() {
    const b = S.staff && S.staff.billing;
    if (!b || S.user.doctorName || (!b.enabled && !b.openCount)) { if (S.receipts && S.receipts.length) { S.receipts = []; if (S.view === 'queue') renderQueue(); } return; }
    if (receiptsBusy) return;
    receiptsBusy = true;
    try {
      const items = (await api('/api/staff/receipts')).items;
      const changed = JSON.stringify(items) !== JSON.stringify(S.receipts || []);
      S.receipts = items;
      if (changed && S.view === 'queue' && !document.getElementById('modal-root').children.length) renderQueue();
    } catch {} finally { receiptsBusy = false; }
  }
  /** Ukončenie vyvolaného pacienta sestrou: pri zapnutých platbách formulár s voľbou Bez priamej úhrady / Platba pacienta. */
  async function finishTicket(t) {
    if (!t) return null;
    const plain = () => act(() => api(`/api/staff/tickets/${t.id}/done`, { body: {} }), `${t.code}: Ukončený`);
    if (!billingOn() || S.user.doctorName || t.status !== 'called') return plain();
    if (S.conn !== 'online') { toast('Nie je spojenie so serverom. Akciu nemožno vykonať.', 'error'); return null; }
    const r = await POK.finishDialog(t, payCtx);
    if (r === 'done') return plain();
    return r;
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

  // po aktualizácii servera sa aplikácia načíta znova sama – len keď používateľ práve nič nevypĺňa
  let bootId = null;
  async function checkBoot() {
    try {
      const h = await (await fetch('/api/health', { cache: 'no-store' })).json();
      if (!h.boot) return;
      if (bootId && h.boot !== bootId) {
        const a = document.activeElement;
        const typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.value;
        if (document.getElementById('modal-root').children.length || typing || S.busy) return;   // skúsi o minútu
        location.reload(); return;
      }
      bootId = h.boot;
    } catch {}
  }
  checkBoot(); setInterval(checkBoot, 60000);

  // ---------- zoznam ----------
  // v2.1: každá ambulancia vidí predvolene svojich pacientov (+ spoločných, napr. z tabletu)
  const showAll = () => lsGet(LS_ALL) === '1';
  const mineFilter = (t) => t.homeRoomId == null || t.homeRoomId === S.roomId;
  const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}` : `${m} min`);
  // v2: poradie = plánovaný čas (ak je zadaný), inak čas príchodu – rovnako ako na serveri
  const orderKey = (t) => t.plannedAt || t.createdAt;
  const byDocOrder = (a, b) => String(a.toDoctorAt || a.createdAt).localeCompare(String(b.toDoctorAt || b.createdAt)) || a.seq - b.seq;
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
  /** 2026-11-18 (Pali): čakanie farebne – červené pri meškaní oproti termínu, zelené pri skoršom príchode (vždy aj s textom). */
  function waitBadge(t, since, now) {
    const w = esc(fmtWait(since, now));
    if (!t.plannedAt) return `<b class="wait-pill">${w}</b>`;
    const late = Math.round((now - Date.parse(t.plannedAt)) / 60000);
    const tol = (S.staff && S.staff.settings.onTimeMinutes) || 0;
    return late > tol ? `<b class="wait-pill late" title="Mešká ${fmtMin(late)} oproti termínu">${w}</b>`
      : late < -tol ? `<b class="wait-pill ok" title="Do termínu ostáva ${fmtMin(-late)}">${w}</b>` : `<b class="wait-pill ok" title="Načas">${w}</b>`;
  }
  function printBadge(p) {
    if (!p || !p.status) return '';
    return `<span class="badge b-p-${esc(p.status)}" title="${esc(p.message || '')}">${esc(PRINT_TEXT[p.status] || p.status)}</span>`;
  }

  /**
   * 2026-11-17: typ a identifikátor pacienta (prichádzajú zo servera len prihlásenému personálu – sestry, lekári, správca;
   * obrazovka v čakárni ani tablet ich nemajú).
   */
  /** 2026-11-20 (Pali): nové výkony majú modré pozadie štítka. */
  const BLUE_TYPES = ['Vstup', 'Vstup hemoroidy', 'Kontrola hemoroidy', 'Pooperačná kontrola hemoroidy'];
  const typeClass = (x) => (BLUE_TYPES.includes(x) ? ' blue' : /^Vstupn/.test(x) ? ' entry' : '');
  function identPill(t) {
    if (!t) return '';
    return (t.patientType ? `<span class="type-pill${typeClass(t.patientType)}" title="Typ pacienta – na obrazovke v čakárni sa neukáže">${esc(t.patientType)}</span>` : '')
      + (t.patientType && t.staffNote ? ' ' : '')
      + (t.staffNote ? `<span class="ident-pill" title="Identifikátor – vidí len personál, na obrazovke v čakárni sa neukáže">🏷 ${esc(t.staffNote)}</span>` : '');
  }
  const hasPriv = (t) => !!(t && (t.staffNote || t.patientType));
  const identField = (t) => {
    const types = (S.staff && S.staff.patientTypes) || [];
    const cur = t && t.patientType;
    return `<div class="row" style="margin-top:14px">
      <div class="field"><label for="m-type">Typ pacienta</label><select id="m-type"><option value="" ${cur ? '' : 'selected'}>— nevybraný —</option>
        ${types.map((x) => `<option class="${typeClass(x).trim()}" ${x === cur ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
      <div class="field"><label for="m-ident">Identifikátor pacienta (nepovinné)</label>
        <input id="m-ident" autocomplete="off" maxlength="60" placeholder="napr. meno alebo poznámka" value="${esc((t && t.staffNote) || '')}"></div></div>
    <p class="hint">Typ a identifikátor vidí len personál v tejto aplikácii (sestry, lekári). Na obrazovke v čakárni ani na tablete sa neukážu. Identifikátor sa po skončení dňa vymaže.</p>`;
  };
  const identBody = (root) => ({ staffNote: root.querySelector('#m-ident').value, patientType: root.querySelector('#m-type').value || null });

  /** 2026-11-18 (Pali): kam pacient z čakárne ide – k sestre (potom k lekárovi), alebo rovno k lekárovi. */
  const stageField = (cur) => `<div class="field" style="margin-top:14px"><label for="m-stage">Pacient ide</label><select id="m-stage">
    <option value="nurse" ${cur === 'doctor' ? '' : 'selected'}>k sestre (potom k lekárovi)</option>
    <option value="doctor" ${cur === 'doctor' ? 'selected' : ''}>rovno k lekárovi (bez sestry)</option></select></div>`;
  const stageSelect = (t, dis) => `<select class="stage-sel needs-online" data-stage-for="${t.id}" ${dis} aria-label="Kam ide pacient ${esc(t.code)}" title="Zmeniť, ku komu pacient ide">
    <option value="nurse" ${t.stage === 'doctor' ? '' : 'selected'}>ide k sestre</option><option value="doctor" ${t.stage === 'doctor' ? 'selected' : ''}>ide k lekárovi</option></select>`;

  function renderQueue() {
    const st = S.staff;
    if (!st) { $view.innerHTML = '<div class="center-msg">Načítava sa zoznam…</div>'; return; }
    const off = S.conn !== 'online';
    const dis = off ? 'disabled' : '';
    const active = roomsActive();
    document.getElementById('who').innerHTML = `<b>${esc(S.user.doctorName || S.user.nurseName || S.user.username)}</b>${S.user.roomId ? ' · ' + esc(roomName(S.user.roomId)) : ''}`;
    const all = showAll();
    const mine = (t) => all || mineFilter(t);
    const isDocAcc = !!S.user.doctorName;
    // 2026-11-17: dva kroky – rad k sestre (podľa termínu) a rad k lekárovi (podľa toho, kedy ich sestra poslala)
    const waitingNurse = st.tickets.filter((t) => t.status === 'waiting' && (t.stage || 'nurse') === 'nurse' && mine(t)).sort(byOrder);
    const waitingDoc = st.tickets.filter((t) => t.status === 'waiting' && t.stage === 'doctor' && mine(t)).sort(byDocOrder);
    // hlavný rad: sestra volá k sebe, lekár k sebe
    const waiting = isDocAcc ? waitingDoc : waitingNurse;
    const called = st.tickets.filter((t) => t.status === 'called' && (all || t.roomId === S.roomId || mineFilter(t))).sort((a, b) => (b.calledAt || '').localeCompare(a.calledAt || ''));
    const finished = st.tickets.filter((t) => (t.status === 'done' || t.status === 'absent') && (all || t.roomId === S.roomId || mineFilter(t))).sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || ''));
    const nWaitAll = st.tickets.filter((t) => t.status === 'waiting' && (isDocAcc ? t.stage === 'doctor' : (t.stage || 'nurse') === 'nurse')).length;
    const nurseNow = (st.nurses || {})[S.roomId] || null;
    const delay = (st.settings.roomDelays || {})[S.roomId];
    const doctor = (st.doctors || {})[S.roomId] || null;
    const closedHere = isClosed(S.roomId);
    const printProblems = st.tickets.filter((t) => (t.status === 'waiting' || t.status === 'called') && t.print && (t.print.status === 'failed' || t.print.status === 'unverified'));
    const now = Date.now();
    const def = Number(lsGet(LS_ROOM));
    const nurse = !S.user.doctorName;   // lekár pacientov nepridáva, nepresúva ani neruší

    const alerts = [];
    if (off) alerts.push(`<div class="alert alert-danger" role="alert"><div class="grow"><b>Bez spojenia so serverom.</b> Zobrazený zoznam nemusí byť aktuálny, akcie sú dočasne vypnuté. Spojenie sa obnoví automaticky.</div></div>`);
    // bez kiosku (čísla prideľuje sestra) upozornenie na vypnutú tlač nemá zmysel – ukáže sa, až keď príde číslo z tabletu
    if (!st.settings.printer.enabled && st.tickets.some((t) => t.source !== 'card')) alerts.push(`<div class="alert alert-warn"><div class="grow"><b>Tlač lístkov je vypnutá.</b> Pacienti dostanú číslo len na obrazovke tabletu.${S.user.role === 'admin' ? ' Zapnete ju v Nastaveniach.' : ''}</div></div>`);
    for (const t of printProblems) {
      alerts.push(`<div class="alert ${t.print.status === 'failed' ? 'alert-danger' : 'alert-warn'}" data-print-alert="${t.id}"><div class="grow">
        <b>Lístok ${esc(t.code)}: ${esc(PRINT_TEXT[t.print.status])}.</b> ${esc(t.print.message || '')}</div>
        <button class="btn btn-sm needs-online" data-act="reprint" data-id="${t.id}" ${dis}>Znovu vytlačiť lístok</button></div>`);
    }
    if (st.dayEnd) alerts.push(`<div class="alert alert-info day-end" role="status"><div class="grow"><b>🏁 Deň je ukončený (od ${esc(fmtTime(st.dayEnd.at))}).</b>
      Tablet už nevydáva poradové čísla a obrazovka v čakárni oznamuje, že dnes už nových pacientov neprijímame. Čakajúcich ešte môžete vyvolať.</div>
      ${nurse ? `<button class="btn btn-sm needs-online" data-act="day-reopen" ${dis}>Obnoviť príjem</button>` : ''}</div>`);
    if (closedHere) alerts.push(`<div class="alert alert-info" role="status"><div class="grow"><b>${esc(roomName(S.roomId))}: dnes tu neordinuje nikto.</b>
      Ambulancia sa nezobrazuje na obrazovke v čakárni ani vo výbere ambulancie. Keď v nej niekto začne ordinovať, zadajte lekára alebo vyvolajte pacienta.</div>
      ${nurse ? `<button class="btn btn-sm needs-online" data-act="room-reopen" ${dis}>Ambulancia ordinuje</button>` : ''}</div>`);
    if (st.announcement) alerts.push(`<div class="alert alert-danger" role="status"><div class="grow"><b>📢 Mimoriadny oznam v čakárni:</b> ${esc(st.announcement.text)}
      <span class="hint">(od ${esc(fmtTime(st.announcement.at))})</span></div>
      <button class="btn btn-sm needs-online" data-act="announce-edit" ${dis}>Upraviť</button>
      <button class="btn btn-sm btn-primary needs-online" data-act="announce-clear" ${dis}>Zrušiť oznam</button></div>`);
    if (delay) alerts.push(`<div class="alert alert-warn"><div class="grow"><b>${esc(roomName(S.roomId))}: v čakárni sa zobrazuje meškanie ${esc(fmtMin(delay.minutes))}.</b>
      ${delay.text ? esc(delay.text) + '. ' : ''}Oznam sa zruší sám pri vyvolaní ďalšieho pacienta.</div>
      <button class="btn btn-sm needs-online" data-act="delay-clear" ${dis}>Zrušiť oznam</button></div>`);
    if (st.previousDayOpen && !S.user.doctorName) alerts.push(`<div class="alert alert-info"><div class="grow">Z dňa ${esc(fmtDay(st.previousDayOpen.day))} ostalo
      ${st.previousDayOpen.count} neukončených čísel. Do dnešného zoznamu sa neprenášajú.</div>
      <button class="btn btn-sm" data-act="open-history" data-day="${esc(st.previousDayOpen.day)}">Zobraziť v histórii</button></div>`);

    // 2026-11-18 (Pali): rýchla zmena ambulancie priamo v riadku radu k lekárovi (2026-11-23 aj v rade k sestre)
    const roomQuick = (t, dis) => `<select class="room-sel amb-pill ${roomColor(t.homeRoomId)} needs-online" data-room-for="${t.id}" ${dis} aria-label="Ambulancia pacienta ${esc(t.code)}" title="Zmeniť ambulanciu">
      ${active.map((r) => `<option value="${r.id}" ${r.id === t.homeRoomId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}<option value="" ${t.homeRoomId ? '' : 'selected'}>Ktorákoľvek</option></select>`;
    const waitRows = waitingNurse.map((t, i) => `<tr data-ticket="${t.id}">
      <td class="code">${esc(t.code)}</td><td class="t-room">${nurse ? roomQuick(t, dis) : ambPill(t.homeRoomId, t.homeRoomName)}${t.source === 'card' ? '' : ' ' + printBadge(t.print)}${hasPriv(t) ? ' ' + identPill(t) : ''}</td>
      <td class="nw t-times"><span class="tl t-plan"><i>termín</i> ${plannedBadge(t, now)}</span><span class="tl t-arr"><i>príchod</i> <b>${esc(fmtTime(t.createdAt))}</b></span><span class="tl t-wait"><i>čaká</i> ${waitBadge(t, t.createdAt, now)}</span></td>
      <td class="actions"><div class="acts">
        <button class="btn btn-sm btn-primary needs-online" data-act="call" data-id="${t.id}" ${dis} title="${isDocAcc ? 'Pacienta si vezmete rovno k sebe (bez sestry)' : 'Vyvolať k sestre'}">${isDocAcc ? 'Vyvolať k sebe' : 'Vyvolať'}${i > 0 || isDocAcc ? '…' : ''}</button>
        <button class="btn btn-sm needs-online" data-act="absent" data-id="${t.id}" ${dis} title="Pacient neprišiel alebo odišiel">⊘ Neprítomný</button>
        ${nurse ? `${stageSelect(t, dis)}
        <button class="btn btn-sm needs-online" data-act="edit" data-id="${t.id}" ${dis} title="Upraviť číslo, čas objednania alebo ambulanciu (napr. pacienta prevezme druhá ambulancia)">✎ Upraviť</button>
        <button class="btn btn-sm btn-danger needs-online" data-act="cancel" data-id="${t.id}" ${dis} title="Zmazať chybne zadaného pacienta">✕ Zmazať</button>` : ''}
        ${t.source === 'card' ? '' : `<button class="btn btn-sm btn-ghost needs-online" data-act="reprint" data-id="${t.id}" ${dis} title="Znovu vytlačiť lístok">🖨 Tlač</button>`}
      </div></td></tr>`).join('');

    const docRows = waitingDoc.map((t, i) => `<tr data-ticket="${t.id}">
      <td class="code">${esc(t.code)}</td><td class="t-room">${nurse ? roomQuick(t, dis) : ambPill(t.homeRoomId, t.homeRoomName)}${hasPriv(t) ? ' ' + identPill(t) : ''}</td>
      <td class="nw t-times"><span class="tl t-plan"><i>termín</i> ${plannedBadge(t, now)}</span><span class="tl"><i>u sestry</i> ${t.nurseCalledAt ? `<b>${esc(fmtTime(t.nurseCalledAt))}</b>` : '<span class="hint" title="Pacient nebol u sestry">—</span>'}</span><span class="tl"><i>k lekárovi</i> <b>${esc(fmtTime(t.toDoctorAt))}</b></span><span class="tl t-wait"><i>čaká</i> ${waitBadge(t, t.toDoctorAt || t.createdAt, now)}</span></td>
      <td class="actions"><div class="acts">
        <button class="btn btn-sm btn-primary needs-online" data-act="call" data-id="${t.id}" ${dis} title="Vyvolať k lekárovi – na TV sa ukáže lekár">Vyvolať k lekárovi${i > 0 ? '…' : ''}</button>
        <button class="btn btn-sm needs-online" data-act="done" data-id="${t.id}" ${dis} title="Ukončiť pacienta bez vyvolania (napr. pri omyle) – dá sa vrátiť v zozname Ukončení a neprítomní">✓ Ukončený</button>
        <button class="btn btn-sm needs-online" data-act="absent" data-id="${t.id}" ${dis} title="Pacient neprišiel alebo odišiel">⊘ Neprítomný</button>
        ${nurse ? `<button class="btn btn-sm needs-online" data-act="to-nurse" data-id="${t.id}" ${dis} title="Pacient sa vráti do radu k sestre (tabuľka Čakajú na sestru)">← Späť k sestre</button>
        <button class="btn btn-sm needs-online" data-act="edit" data-id="${t.id}" ${dis} title="Upraviť číslo, ambulanciu, typ alebo to, ku komu pacient ide">✎ Upraviť</button>` : ''}
      </div></td></tr>`).join('');

    const stagePill = (t) => (t.stage === 'doctor' ? '<span class="stage-pill doc">u lekára</span>'
      : t.stage === 'final' ? '<span class="stage-pill nurse fin">u sestry · ukončenie</span>' : '<span class="stage-pill nurse">u sestry</span>');
    // 2026-11-18 (Pali): po lekárovi ide pacient späť k sestre na ukončenie (platba, papiere) – „Ukončený“ potvrdí až sestra
    const finalRow = (t) => `<tr data-ticket="${t.id}" class="is-final ${roomColor(t.roomId)}">
      <td class="code">${esc(t.code)}</td><td class="c-room">${stagePill(t)} ${t.roomName ? ambPill(t.roomId, t.roomName) : ''}${hasPriv(t) ? ' ' + identPill(t) : ''}</td><td class="c-time">od lekára ${esc(fmtTime(t.finalAt))}</td>
      <td class="c-count">${t.callCount}×</td>
      <td class="actions"><div class="acts">
        ${nurse ? `<button class="btn btn-sm btn-primary needs-online" data-act="done" data-id="${t.id}" ${dis} title="Pacient zaplatil, má papiere a odchádza">✓ Ukončený</button>` : ''}
        <button class="btn btn-sm needs-online" data-act="back-to-doctor" data-id="${t.id}" ${dis} title="Omyl – pacient je ešte u lekára">← Späť k lekárovi</button>
        ${nurse ? `<button class="btn btn-sm needs-online" data-act="absent" data-id="${t.id}" ${dis} title="Pacient neprišiel alebo odišiel">⊘ Neprítomný</button>
        <button class="btn btn-sm btn-ghost needs-online" data-act="note" data-id="${t.id}" ${dis} title="Typ pacienta a identifikátor (vidí len personál)">🏷 Identifikátor</button>` : ''}
        ${nurse ? `<button class="btn btn-sm needs-online" data-act="move-room" data-id="${t.id}" ${dis} title="Pacient musí ísť do inej ambulancie (napr. k inému lekárovi) – odíde do čakárne a zaradí sa do jej radu">⇄ Zmeniť ambulanciu</button>` : ''}
      </div></td></tr>`;
    const calledRow = (t) => (t.stage === 'final' ? finalRow(t) : `<tr data-ticket="${t.id}" class="${roomColor(t.roomId)}">
      <td class="code">${esc(t.code)}</td><td class="c-room">${stagePill(t)} ${t.roomName ? ambPill(t.roomId, t.roomName) : ''}${hasPriv(t) ? ' ' + identPill(t) : ''}</td><td class="c-time">vyvolaný ${esc(fmtTime(t.calledAt))}</td>
      <td class="c-count">${t.callCount}×</td>
      <td class="actions"><div class="acts">
        ${nurse && t.stage !== 'doctor' ? `<button class="btn btn-sm btn-primary needs-online" data-act="to-doctor" data-id="${t.id}" ${dis} title="Pacient ide von do čakárne a lekár si ho vyvolá – na TV sa ukáže lekár">→ K lekárovi</button>
        <button class="btn btn-sm btn-dark needs-online" data-act="to-doctor-direct" data-id="${t.id}" ${dis} title="Pacient ide k lekárovi hneď, bez čakania v čakárni">→ Priamo k lekárovi</button>` : ''}
        ${t.stage === 'doctor' ? `<button class="btn btn-sm btn-primary needs-online" data-act="to-final" data-id="${t.id}" ${dis} title="Vyšetrenie u lekára sa skončilo – pacient ide k sestre (platba, papiere), ukončí ho sestra">→ K sestre na ukončenie</button>` : ''}
        ${nurse && t.stage !== 'doctor' ? `<button class="btn btn-sm needs-online" data-act="done" data-id="${t.id}" ${dis} title="Pacient odchádza bez lekára">✓ Ukončený bez lekára</button>` : ''}
        <button class="btn btn-sm needs-online" data-act="recall" data-id="${t.id}" ${dis} title="Zopakovať vyvolanie na obrazovke">🔔 Zopakovať</button>
        <button class="btn btn-sm needs-online" data-act="absent" data-id="${t.id}" ${dis} title="Pacient neprišiel alebo odišiel">⊘ Neprítomný</button>
        <button class="btn btn-sm btn-ghost needs-online" data-act="requeue" data-id="${t.id}" ${dis} title="Vrátiť medzi čakajúcich">↩ Vrátiť</button>
        ${nurse ? `<button class="btn btn-sm btn-ghost needs-online" data-act="note" data-id="${t.id}" ${dis} title="Typ pacienta a identifikátor (vidí len personál)">🏷 Identifikátor</button>` : ''}
        ${nurse ? `<button class="btn btn-sm needs-online" data-act="move-room" data-id="${t.id}" ${dis} title="Pacient musí ísť do inej ambulancie (napr. k inému lekárovi) – odíde do čakárne a zaradí sa do jej radu">⇄ Zmeniť ambulanciu</button>` : ''}
      </div></td></tr>`);

    // 2026-11-18 (Pali): „Práve v ambulancii“ rozdelené – kto je u sestry (aj na ukončení) a kto u lekára
    const atNurse = called.filter((t) => t.stage !== 'doctor'), atDoctor = called.filter((t) => t.stage === 'doctor');
    // 2026-11-18 (Pali): každý má samostatné okno – pacient sa zobrazuje v okne toho, u koho práve je
    const grp = (cls, title, list, empty) => `<section class="card now ${cls}"><div class="panel-title"><h2><span class="live-dot" aria-hidden="true"></span>${title} (${list.length})</h2></div>
      ${list.length ? `<table><tbody>${list.map(calledRow).join('')}</tbody></table>` : `<div class="empty">${empty}</div>`}</section>`;
    const calledRows = grp('now-nurse', 'Práve u sestry', atNurse, 'U sestry teraz nie je nikto.') + grp('now-doctor', 'Práve u lekára', atDoctor, 'U lekára teraz nie je nikto.');

    // 2026-11-18 (Pali): ukončení a neprítomní dole na celú šírku so všetkými údajmi
    const tm = (v) => (v ? esc(fmtTime(v)) : '<span class="hint">—</span>');
    const finRows = finished.slice(0, 60).map((t) => `<tr data-ticket="${t.id}">
      <td class="code">${esc(t.code)}</td><td><span class="badge b-${t.status}">${esc(STATUS_TEXT[t.status])}</span>${POK.payLine(payOf(t))}</td>
      <td class="f-pat">${hasPriv(t) ? identPill(t) : '<span class="hint">—</span>'}</td>
      <td>${t.roomName || t.homeRoomName ? ambPill(t.roomName ? t.roomId : t.homeRoomId, t.roomName || t.homeRoomName) : ''}</td>
      <td class="nw">${t.plannedAt ? `<b>${esc(fmtTime(t.plannedAt))}</b>` : '<span class="hint">—</span>'}</td>
      <td class="nw">${tm(t.createdAt)}</td><td class="nw">${tm(t.nurseCalledAt)}</td><td class="nw">${tm(t.toDoctorAt)}</td>
      <td class="nw">${tm(t.stage === 'doctor' || t.stage === 'final' ? t.calledAt : null)}</td><td class="nw">${tm(t.finalAt)}</td><td class="nw"><b>${tm(t.finishedAt)}</b></td>
      <td class="actions"><div class="acts">${payOf(t) ? '' : `<button class="btn btn-sm btn-ghost needs-online" data-act="requeue" data-id="${t.id}" ${dis} title="Vrátiť medzi čakajúcich">↩ Vrátiť</button>`}
        ${nurse && t.status !== 'cancelled' ? `<button class="btn btn-sm needs-online" data-act="move-room" data-id="${t.id}" ${dis} title="Opraviť ambulanciu, v ktorej pacient bol (aj v štatistikách)">⇄ Ambulancia</button>` : ''}</div></td></tr>`).join('');

    // ďalší na rade – veľká karta s hlavnou akciou
    const next = waiting[0] || null;
    let heroInfo;
    if (next) {
      const pills = hasPriv(next) ? [identPill(next)] : [];
      pills.push(`<span class="pill">príchod ${esc(fmtTime(next.createdAt))}</span>`, `<span class="pill">čaká ${esc(fmtWait(next.createdAt, now))}</span>`);
      if (next.plannedAt && !isDocAcc) {
        const late = Math.round((now - Date.parse(next.plannedAt)) / 60000);
        const tol = st.settings.onTimeMinutes || 0;
        pills.push(late > tol ? `<span class="pill late">mešká sa ${esc(fmtMin(late))}</span>` : `<span class="pill ok">v čase</span>`);
      }
      heroInfo = `<div class="hero-kicker">${isDocAcc ? 'Ďalší na rade k lekárovi' : 'Ďalší na rade k sestre'}</div>
        <div class="hero-main">${isDocAcc ? 'Od sestry ' + esc(fmtTime(next.toDoctorAt)) : next.plannedAt ? 'Termín ' + esc(fmtTime(next.plannedAt)) : 'Bez termínu'}${waiting.length > 1 ? ` · potom ešte ${waiting.length - 1}` : ''}</div>
        <div class="hero-meta">${pills.join('')}</div>`;
    } else {
      heroInfo = `<div class="hero-kicker">${isDocAcc ? 'Ďalší na rade k lekárovi' : 'Ďalší na rade k sestre'}</div><div class="hero-main">${isDocAcc ? 'Na lekára nikto nečaká' : 'Nikto nečaká'}</div>
        <div class="hero-meta"><span class="pill">${isDocAcc ? 'Pacientov k vám posiela sestra' : 'Pacienta pridáte tlačidlom „+ Pacient“'}</span></div>`;
    }

    function nurseSection() {
      return `<div><div class="section-title"><h2>Čakajú na sestru (${waitingNurse.length})</h2><span class="hint">${esc(fmtDay(st.day))}</span></div>
        ${waitingNurse.length ? `<table id="tbl-waiting"><thead><tr><th>Číslo</th><th>Ambulancia</th><th title="Termín objednania, príchod a čakanie">Časy</th><th></th></tr></thead><tbody>${waitRows}</tbody></table>`
          : '<div class="empty">Nikto nečaká.</div>'}</div>`;
    }
    function docSection() {
      return `<div><div class="section-title"><h2>Čakajú na lekára (${waitingDoc.length})</h2><span class="hint">po sestre alebo rovno k lekárovi</span></div>
        ${waitingDoc.length ? `<table id="tbl-doctor"><thead><tr><th>Číslo</th><th>Ambulancia</th><th title="Termín objednania, vyvolanie sestrou, zaradenie k lekárovi a čakanie">Časy</th><th></th></tr></thead><tbody>${docRows}</tbody></table>`
          : `<div class="empty">${isDocAcc ? 'Sestra k vám zatiaľ nikoho neposlala.' : 'Nikto nečaká na lekára.'}</div>`}</div>`;
    }

    // zachovanie pozície posúvania pri prekreslení
    const scroll = window.scrollY;
    const fin = document.querySelector('.fin-wrap');
    const finScroll = fin ? fin.scrollTop : 0;
    // pracovisko: veľký názov ambulancie, kam sa vyvoláva – vo farbe ambulancie (roomColor)
    const ri = Math.max(0, active.findIndex((r) => r.id === S.roomId));
    const roomNow = active[ri];
    const roomNo = roomNow ? ((String(roomNow.name).match(/(\d+)/) || [])[1] || String(ri + 1)) : '–';
    // 2026-11-18 (Pali): prepínač pohľadu – lekár vidí len lekársku časť, sestra len sesterskú, alebo obe;
    // predvolené podľa typu konta, voľba sa pamätá pre konto na tomto zariadení
    const pohlad = pohladGet();
    $view.innerHTML = `<div class="dash pohlad-${pohlad}">
      <div class="a-room stack"><section class="roombar ${roomNow ? roomColor(roomNow.id) : ''}" aria-label="Pracovisko">
        <div class="rb-id"><div class="rb-num" aria-hidden="true">${esc(roomNo)}</div>
          <div class="rb-text"><div class="rb-kicker">Vyvolávate do</div><div class="rb-name" id="room-name">${roomNow ? esc(roomNow.name) : '⚠ Vyberte pracovisko'}</div></div></div>
        <div class="rb-btns">
          <button class="btn needs-online ${doctor || S.user.doctorName || closedHere ? '' : 'need'}" id="btn-doctor" ${dis} title="Lekár, ktorého meno sa ukáže na TV pri vyvolaní">${doctor ? '👩‍⚕️ ' + esc(doctor) : S.user.doctorName ? '👩‍⚕️ ' + esc(S.user.doctorName) : closedHere ? 'Dnes neordinuje nikto' : '⚠ Zadať lekára'}</button>
          ${S.user.doctorName ? '' : `<button class="btn needs-online ${nurseNow || S.user.nurseName || closedHere ? '' : 'need'}" id="btn-nurse" ${dis} title="Sestra, ktorej meno a fotka sa ukáže na TV pri prvom vyvolaní pacienta">${S.user.nurseName || nurseNow ? '🩺 ' + esc(S.user.nurseName || nurseNow) : closedHere ? 'Sestra –' : '⚠ Zadať sestru'}</button>`}
          <button class="btn needs-online ${delay ? 'on' : ''}" id="btn-delay" ${dis} title="Oznam do čakárne, že pracovisko mešká (napr. predĺžený výkon)">${delay ? `Meškanie ${fmtMin(delay.minutes)}` : 'Hlásiť meškanie'}</button>
          <button class="btn needs-online ${st.announcement ? 'on' : ''}" id="btn-announce" ${dis} title="Mimoriadny oznam na obrazovke v čakárni">📢 ${st.announcement ? 'Oznam je zapnutý' : 'Mimoriadny oznam'}</button>
          ${nurse ? `<button class="btn needs-online ${st.dayEnd ? 'on' : ''}" id="btn-day-end" ${dis} title="Dnes už nových pacientov neprijímame – tablet prestane vydávať čísla, TV ukáže oznam">🏁 ${st.dayEnd ? 'Deň je ukončený' : 'Ukončiť deň'}</button>` : ''}
        </div>
        <div class="rb-pick">
          <label class="lbl" for="room">Zmeniť pracovisko</label>
          <select id="room">${active.map((r) => `<option value="${r.id}" ${r.id === S.roomId ? 'selected' : ''}>${esc(r.name)}${r.id === def ? ' (predvolená)' : ''}${isClosed(r.id) ? ' – dnes neordinuje' : ''}</option>`).join('')}</select>
          <label class="check hint"><input type="checkbox" id="room-def" ${S.roomId === def ? 'checked' : ''}> Predvolená pre tento počítač</label>
          <label class="check hint"><input type="checkbox" id="show-all" ${all ? 'checked' : ''}> Pacienti všetkých pracovísk</label>
        </div>
      </section>
      ${alerts.length ? `<div class="a-alerts">${alerts.join('')}</div>` : ''}</div>

      <div class="counts a-counts">
        <div class="count c-wait"><b id="cnt-waiting">${waiting.length}</b><span>${isDocAcc ? 'čaká na vás' : 'čaká na sestru'}${!all && nWaitAll > waiting.length ? ` (spolu ${nWaitAll})` : ''}</span></div>
        <div class="count"><b id="cnt-doctor">${isDocAcc ? waitingNurse.length : waitingDoc.length}</b><span>${isDocAcc ? 'čaká na sestru' : 'čaká na lekára'}</span></div>
        <div class="count"><b>${called.length}</b><span>vyvolaní</span></div>
        <div class="count c-done"><b>${finished.filter((t) => t.status === 'done').length}</b><span>ukončení · ${finished.filter((t) => t.status === 'absent').length} neprít.</span></div>
      </div>

      <section class="hero a-hero" aria-label="Ďalší na rade">
        <div class="hero-tile ${next ? (next.code.length > 3 ? 'long' : '') : 'empty'}">${next ? esc(next.code) : '—'}</div>
        <div class="hero-info">${heroInfo}</div>
        <div class="hero-actions">
          <button class="btn btn-xl btn-call needs-online" id="btn-next" ${off || !waiting.length || !S.roomId ? 'disabled' : ''}>Vyvolať ďalšieho${waiting.length ? ' (' + esc(waiting[0].code) + ')' : ''}</button>
          <button class="btn btn-add needs-online" id="btn-card" ${dis}>+ Pacient</button>
        </div>
      </section>

      <div class="a-viewbar viewbar" role="group" aria-label="Pohľad">
        <span class="vb-lbl">Pohľad</span>
        ${[['nurse', '🩺 Len sestra'], ['both', 'Sestra aj lekár'], ['doctor', '👩‍⚕️ Len lekár']].map(([k, l]) =>
          `<button type="button" class="vb-btn ${pohlad === k ? 'on' : ''}" data-pohlad="${k}" aria-pressed="${pohlad === k}">${l}</button>`).join('')}
      </div>

      <div class="a-now now-pair" id="tbl-called">${calledRows}</div>

      <div class="a-queues">
        <section class="card q-nurse">${nurseSection()}</section>
        <section class="card q-doctor">${docSection()}</section>
      </div>

      <div class="a-fin-area">${nurse ? POK.receiptsSection(S.receipts, S.user.role === 'admin') : ''}
      <section class="card a-finished"><div class="section-title"><h2>Ukončení a neprítomní (${finished.length})</h2><span class="hint">omylom ukončeného vrátite tlačidlom Vrátiť</span></div>
        ${finished.length ? `<div class="fin-wrap"><table id="tbl-finished"><thead><tr><th>Číslo</th><th>Stav</th><th>Pacient</th><th>Ambulancia</th><th title="Čas, na ktorý bol pacient objednaný">Termín</th><th>Príchod</th><th title="Kedy pacienta vyvolala sestra">U sestry</th><th title="Odkedy čakal na lekára">K lekárovi</th><th title="Kedy pacienta vyvolal lekár">U lekára</th><th title="Kedy ho lekár poslal späť k sestre na ukončenie">Späť u sestry</th><th>Ukončený</th><th></th></tr></thead><tbody>${finRows}</tbody></table></div>`
          : '<div class="empty">Zatiaľ nikto.</div>'}
      </section></div></div>`;
    const fin2 = document.querySelector('.fin-wrap');
    if (fin2) fin2.scrollTop = finScroll;
    window.scrollTo(0, scroll);

    const sel = document.getElementById('room');
    if (sel) sel.onchange = () => { S.roomId = Number(sel.value); renderQueue(); };
    const defBox = document.getElementById('room-def');
    if (defBox) defBox.onchange = () => { lsSet(LS_ROOM, defBox.checked ? String(S.roomId) : null); renderQueue(); };
    document.getElementById('btn-card').onclick = () => addCard();
    document.getElementById('btn-delay').onclick = () => reportDelay();
    const bn = document.getElementById('btn-nurse');
    if (bn) bn.onclick = () => askDoctor(false);
    document.getElementById('btn-announce').onclick = () => announce();
    const isDoc = !!S.user.doctorName;
    document.getElementById('btn-doctor').onclick = isDoc ? () => toast('Vaše meno sa na TV nastaví samo pri prvom vyvolaní.', 'ok') : () => askDoctor(false);
    // povinný údaj na začiatku dňa: bez lekára sa okno nedá zavrieť (lekárske konto sa nastaví samo)
    const de = document.getElementById('btn-day-end');
    if (de) de.onclick = () => (st.dayEnd ? reopenDay() : endDay());
    if (!isDoc && (!doctor || !nurseNow) && !closedHere && !off && S.roomId && !S.doctorAsked && !document.getElementById('modal-root').children.length && !S.askingDoctor) askDoctor(true);
    document.querySelectorAll('[data-pohlad]').forEach((b) => { b.onclick = () => { lsSet(LS_POHLAD + S.user.username, b.dataset.pohlad); renderQueue(); }; });
    document.getElementById('show-all').onchange = (e) => { lsSet(LS_ALL, e.target.checked ? '1' : null); renderQueue(); };
    document.getElementById('btn-next').onclick = () => act(
      () => api('/api/staff/call-next', { body: { roomId: S.roomId, stage: isDocAcc ? 'doctor' : 'nurse' } }),
      (r) => `Vyvolané ${r.ticket.code} – ${r.ticket.roomName}`);
  }

  // zmena „ide k sestre / ide k lekárovi“ priamo v tabuľke čakajúcich
  $view.addEventListener('change', (e) => {
    const rs = e.target.closest('select[data-room-for]');
    if (rs && S.staff) {
      const rt = S.staff.tickets.find((x) => x.id === Number(rs.dataset.roomFor));
      if (!rt) return;
      act(() => api(`/api/staff/tickets/${rt.id}/room`, { body: { roomId: rs.value ? Number(rs.value) : null } }),
        `${rt.code}: ${rs.value ? rs.options[rs.selectedIndex].text : 'ktorákoľvek ambulancia'}`).then((r) => { if (!r) renderQueue(); });
      return;
    }
    const sel = e.target.closest('select[data-stage-for]');
    if (!sel || !S.staff) return;
    const t = S.staff.tickets.find((x) => x.id === Number(sel.dataset.stageFor));
    if (!t) return;
    act(() => api(`/api/staff/tickets/${t.id}/edit`, { body: { stage: sel.value } }),
      sel.value === 'doctor' ? `${t.code}: ide rovno k lekárovi` : `${t.code}: ide k sestre`).then((r) => { if (!r) renderQueue(); });
  });

  // akcie v zozname (delegovanie udalostí)
  $view.addEventListener('click', async (e) => {
    const pb = e.target.closest('button[data-pay-act]');
    if (pb) {
      const pid = Number(pb.dataset.payId);
      if (pb.dataset.payAct === 'reprint') { pb.disabled = true; await POK.reprint(pid, payCtx); }
      if (pb.dataset.payAct === 'resolve') await POK.resolveDialog(pid, payCtx);
      return loadReceipts();
    }
    const b = e.target.closest('button[data-act]');
    if (!b || !S.staff) return;
    const id = Number(b.dataset.id);
    const t = S.staff.tickets.find((x) => x.id === id);
    const code = t ? t.code : '';
    switch (b.dataset.act) {
      case 'call': return callTicket(t);
      case 'recall': return act(() => api(`/api/staff/tickets/${id}/recall`, { body: {} }), `Vyvolanie ${code} zopakované`);
      case 'to-doctor': return act(() => api(`/api/staff/tickets/${id}/to-doctor`, { body: {} }), `${code}: ide do čakárne, čaká na lekára`);
      case 'to-nurse': return act(() => api(`/api/staff/tickets/${id}/edit`, { body: { stage: 'nurse' } }), `${code}: späť k sestre`);
      case 'to-final': return act(() => api(`/api/staff/tickets/${id}/to-final`, { body: {} }), `${code}: k sestre na ukončenie`);
      case 'back-to-doctor': return act(() => api(`/api/staff/tickets/${id}/back-to-doctor`, { body: {} }), `${code}: späť k lekárovi`);
      case 'to-doctor-direct': return act(() => api(`/api/staff/tickets/${id}/to-doctor`, { body: { direct: true } }), `${code}: priamo k lekárovi`);
      case 'done': return finishTicket(t);
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
      case 'edit': return editTicket(t);
      case 'note': return noteTicket(t);
      case 'move-room': return moveRoomTicket(t);
      case 'cancel': {
        const ok = await confirmDialog(`Zmazať pacienta ${code}?`, `Číslo ${code} sa odstráni zo zoznamu čakajúcich, ako keby nebolo zadané (nezapočíta sa ani do štatistík). Použite pri chybnom zadaní.`, 'Zmazať pacienta', true);
        if (ok) act(() => api(`/api/staff/tickets/${id}/cancel`, { body: {} }), `Pacient ${code} bol zmazaný`);
        return;
      }
      case 'announce-edit': return announce();
      case 'announce-clear': return act(() => api('/api/staff/announcement', { body: { text: null } }), 'Mimoriadny oznam bol zrušený.');
      case 'delay-clear': return act(() => api(`/api/staff/rooms/${S.roomId}/delay`, { body: { minutes: null } }), 'Oznam o meškaní bol zrušený.');
      case 'open-history': S.historyDay = b.dataset.day; return go('history');
      case 'day-reopen': return reopenDay();
      case 'room-reopen': return act(() => api(`/api/staff/rooms/${S.roomId}/closed`, { body: { closed: false } }), `${roomName(S.roomId)} dnes opäť ordinuje.`);
    }
  });

  /** v2.2: lekár, ktorý dnes ordinuje v ambulancii – na TV sa ukáže namiesto názvu ambulancie. */
  async function askDoctor(required) {
    S.askingDoctor = true;
    delete document.getElementById('modal-root').dataset.closed;
    const list = (S.staff.settings.doctorList || []);
    const cur = (S.staff.doctors || {})[S.roomId] || '';
    const nlist = (S.staff.settings.nurseList || []);
    const ncur = (S.staff.nurses || {})[S.roomId] || '';
    try {
      const res = await modal({
        title: required ? `Dobré ráno – kto dnes slúži v ambulancii ${roomName(S.roomId)}?` : `Sestra a lekár – ${roomName(S.roomId)}`,
        okText: 'Uložiť',
        cancelText: required ? 'Neskôr' : 'Zrušiť',
        body: `<p class="hint">Meno sa ukáže na obrazovke v čakárni pri vyvolaní pacienta. Počas dňa ho môžete kedykoľvek zmeniť tlačidlom s menom lekára.</p>
          <div class="field"><label for="m-doc">Meno a priezvisko lekára (alebo iniciály)</label>
            <input id="m-doc" list="m-doc-list" maxlength="60" value="${esc(cur)}" autocomplete="off" placeholder="napr. MUDr. Ján Novák" autofocus>
            <datalist id="m-doc-list">${list.map((n) => `<option value="${esc(n)}">`).join('')}</datalist></div>
          ${list.length ? `<div class="row" style="flex-wrap:wrap;gap:8px;margin-top:10px">${list.map((n) => `<button type="button" class="btn btn-sm" data-doc="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
          <div class="field" style="margin-top:16px"><label for="m-nurse">Sestra (pacient ide najprv k nej – na TV sa pri prvom vyvolaní ukáže jej meno a fotka)</label>
            <input id="m-nurse" list="m-nurse-list" maxlength="60" value="${esc(ncur)}" autocomplete="off" placeholder="napr. Daniela Fetyková alebo meno zastupujúcej sestry">
            <datalist id="m-nurse-list">${nlist.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
            <span class="hint">Zastupujúca sestra alebo externistka bez fotky sa na TV ukáže s ilustračným obrázkom a označením „Sestra“.</span></div>
          ${nlist.length ? `<div class="row" style="flex-wrap:wrap;gap:8px;margin-top:10px">${nlist.map((n) => `<button type="button" class="btn btn-sm" data-nurse="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
          <div class="closed-pick"><button type="button" class="btn btn-sm btn-dark" id="m-closed">Dnes v tejto ambulancii neordinuje nikto</button>
            <span class="hint">Ambulancia sa dnes nebude zobrazovať na obrazovke v čakárni ani vo výbere ambulancie.</span></div>`,
        onOk: async (root) => {
          if (root.dataset.closed) { delete root.dataset.closed; return api(`/api/staff/rooms/${S.roomId}/closed`, { body: { closed: true } }); }
          const name = root.querySelector('#m-doc').value.trim();
          if (name.length < 2) throw new Error('Zadajte meno lekára – je to povinný údaj pre dnešný deň.');
          const nurse = root.querySelector('#m-nurse').value.trim();
          if (nurse.length === 1) throw new Error('Zadajte celé meno sestry.');
          const r = await api(`/api/staff/rooms/${S.roomId}/doctor`, { body: { name } });
          if (nurse !== ncur) await api(`/api/staff/rooms/${S.roomId}/nurse`, { body: { name: nurse } });
          return r;
        },
      });
      if (res && res.roomsClosed) toast(`${roomName(S.roomId)}: dnes neordinuje nikto – na TV sa nezobrazuje.`, 'ok');
      else if (res) toast('Sestra a lekár boli uložení.', 'ok');
      else if (required) toast('Bez zadaného lekára sa na TV ukáže len názov ambulancie.', 'error');
    } finally { S.askingDoctor = false; S.doctorAsked = true; }
  }
  // „Dnes v tejto ambulancii neordinuje nikto“ priamo z okna výberu lekára
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#m-closed')) return;
    document.getElementById('modal-root').dataset.closed = '1';
    document.getElementById('m-ok').click();
  });

  /** 2026-11-17 (Pali): „Ukončiť deň“ – dnes už nových pacientov neprijímame (tablet nevydáva čísla, TV ukáže oznam). */
  async function endDay() {
    const w = S.staff.counts.waiting;
    const ok = await confirmDialog('Ukončiť deň?', `Tablet prestane vydávať poradové čísla a obrazovka v čakárni oznámi, že dnes už nových pacientov neprijímame.
      ${w ? `Čakajúcich pacientov (${w}) môžete ešte normálne vyvolať.` : 'Nikto nečaká – TV ukáže „Dnes už neordinujeme“.'} Príjem sa dá kedykoľvek obnoviť, zajtra sa začne sám.`, 'Ukončiť deň');
    if (!ok) return;
    const r = await act(() => api('/api/staff/day-end', { body: { ended: true } }), 'Deň je ukončený – nové čísla sa už nevydávajú.');
    if (r) celebrate();
  }

  /**
   * 2026-11-23 (Pali): po „Ukončiť deň“ poďakovanie s ohňostrojom – pre toho, kto tlačidlo stlačil (len v tejto aplikácii, nie na TV).
   * Čísla sú len súhrnné (počty a priemer), žiadne údaje o pacientoch.
   */
  const FIN_QUOTES = [
    (n) => `${n} ľudí dnes odišlo s lepším pocitom, než s akým prišli. To je dobrý deň.`,
    () => 'Čakáreň je prázdna a to je tvoja zásluha. Vypni, vydýchni, zajtra zas.',
    () => 'Dnes to išlo ako po masle. A ak nie, aj tak je to zvládnuté na jednotku.',
    (n) => `${n} vyvolaní, nula zabudnutých. Presne takto sa to robí.`,
    () => 'Žily dnes boli v dobrých rukách. Teraz si daj nohy hore aj ty.',
    () => 'Poriadok v čakárni nerobí systém, ale ľudia, čo ho používajú. Ďakujeme.',
    () => 'Káva bola dnes zaslúžená už ráno. Teraz je zaslúžený aj pokoj.',
  ];
  async function celebrate() {
    const ts = (S.staff && S.staff.tickets) || [];
    const done = ts.filter((t) => t.status === 'done').length, absent = ts.filter((t) => t.status === 'absent').length;
    let avgWait = null;
    try { avgWait = (await api('/api/staff/today-stats')).total.avgWait; } catch {}
    const room = S.staff && S.staff.rooms.find((x) => x.id === S.roomId);
    const first = ((S.staff && (S.staff.nurses || {})[S.roomId]) || '').split(/\s+/).find((w) => w && !w.endsWith('.')) || '';
    const day = new Date();
    const quote = FIN_QUOTES[Math.floor(day.getTime() / 86400000) % FIN_QUOTES.length](done);
    const head = `${day.toLocaleDateString('sk-SK', { weekday: 'long', day: 'numeric', month: 'long' })}${room ? ' · ' + room.name : ''}`;
    const el = document.createElement('div');
    el.id = 'fin'; el.className = 'fin-back';
    el.innerHTML = `<canvas id="fin-canvas" aria-hidden="true"></canvas>
      <div class="fin" role="dialog" aria-modal="true" aria-labelledby="fin-title">
        <div class="fin-top"><small>${esc(head)}</small><h2 id="fin-title">Hotovo, deň je za tebou! 🎉</h2>
          <svg class="fin-medal" width="112" height="112" viewBox="0 0 112 112" aria-hidden="true"><circle cx="56" cy="56" r="54" fill="#fff"/><circle cx="56" cy="56" r="46" fill="#F2B632"/><circle cx="56" cy="56" r="38" fill="#FFD766"/>
            <path d="M56 78 C30 60 34 40 47 40 c5 0 8 3 9 6 c1-3 4-6 9-6 c13 0 17 20 -9 38z" fill="#c8102e"/><path d="M36 58h10l4-9 6 16 5-10 3 3h12" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <div class="fin-body"><p class="fin-lead">Ďakujeme${first ? ', ' + esc(first) : ''}. Dnes máš za sebou <b>${done} ${done === 1 ? 'pacienta' : 'pacientov'}</b>.</p>
          <div class="fin-tiles"><div class="fin-tile g"><b>${done}</b><span>ukončených pacientov</span></div>
            <div class="fin-tile"><b>${avgWait == null ? '–' : fmtMin(avgWait)}</b><span>priemerné čakanie</span></div>
            <div class="fin-tile ${absent ? 'r' : ''}"><b>${absent}</b><span>neprítomných</span></div></div>
          <div class="fin-quote">„${esc(quote)}“</div>
          <button type="button" class="btn btn-primary" id="fin-close">Zaslúžený oddych 👋</button></div></div>`;
    document.body.appendChild(el);
    const stop = fireworks(el.querySelector('#fin-canvas'));
    const close = () => { stop(); document.removeEventListener('keydown', onKey); el.remove(); };
    const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); } };
    document.addEventListener('keydown', onKey);
    el.querySelector('#fin-close').onclick = close;
    el.onclick = (e) => { if (e.target === el || e.target.id === 'fin-canvas') close(); };
    el.querySelector('#fin-close').focus();
  }

  /** Animovaný ohňostroj a konfety na plátne. Pri „obmedziť pohyb“ v systéme sa nakreslia len nehybné konfety. Vráti funkciu na zastavenie. */
  function fireworks(cv) {
    const ctx = cv.getContext('2d');
    const COLORS = ['#c8102e', '#ff5a6e', '#F2B632', '#FFD766', '#ffffff', '#3fae6a', '#5aa2ea'];
    const rnd = (a, b) => a + Math.random() * (b - a), pick = () => COLORS[Math.floor(Math.random() * COLORS.length)];
    let W = 0, H = 0, raf = 0, last = 0, nextRocket = 0, t0 = 0, alive = true;
    const size = () => { W = cv.width = cv.clientWidth; H = cv.height = cv.clientHeight; };
    size(); window.addEventListener('resize', size);
    const rockets = [], sparks = [], confetti = [];
    for (let i = 0; i < 140; i++) confetti.push({ x: rnd(0, W), y: rnd(-H, 0), w: rnd(6, 13), h: rnd(8, 18), c: pick(), vy: rnd(70, 190), vx: rnd(-30, 30), a: rnd(0, 6.3), va: rnd(-4, 4) });
    const drawConfetti = (dt) => { for (const c of confetti) {
      c.y += c.vy * dt; c.x += c.vx * dt; c.a += c.va * dt; if (c.y > H + 20) { c.y = -20; c.x = rnd(0, W); }
      ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.a); ctx.fillStyle = c.c; ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h * Math.abs(Math.cos(c.a * 1.3)) + 2); ctx.restore(); } };
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const c of confetti) c.y = rnd(0, H);
      drawConfetti(0);
      return () => window.removeEventListener('resize', size);
    }
    const burst = (x, y) => { const c1 = pick(), c2 = pick(), n = 70 + Math.floor(rnd(0, 50)), sp = rnd(150, 300);
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + rnd(-0.05, 0.05), v = sp * rnd(0.55, 1); sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rnd(0.9, 1.6), t: 0, c: i % 3 ? c1 : c2 }); } };
    const frame = (now) => {
      if (!alive) return;
      if (!t0) { t0 = last = now; }
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      ctx.clearRect(0, 0, W, H);
      if (now >= nextRocket) { rockets.push({ x: rnd(W * 0.12, W * 0.88), y: H + 10, vy: -rnd(520, 760), ty: rnd(H * 0.12, H * 0.45), c: pick() }); nextRocket = now + (now - t0 < 6000 ? rnd(220, 520) : rnd(900, 1800)); }
      for (let i = rockets.length - 1; i >= 0; i--) { const r = rockets[i]; r.y += r.vy * dt; r.vy += 260 * dt;
        ctx.fillStyle = r.c; ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.arc(r.x, r.y, 3, 0, 6.3); ctx.fill(); ctx.globalAlpha = 0.35; ctx.fillRect(r.x - 1, r.y, 2, 26);
        if (r.y <= r.ty || r.vy >= -40) { burst(r.x, r.y); rockets.splice(i, 1); } }
      for (let i = sparks.length - 1; i >= 0; i--) { const p = sparks[i]; p.t += dt; if (p.t >= p.life) { sparks.splice(i, 1); continue; }
        p.vx *= 1 - 1.6 * dt; p.vy = p.vy * (1 - 1.6 * dt) + 130 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
        ctx.globalAlpha = Math.max(0, 1 - p.t / p.life); ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(p.x, p.y, 2.6, 0, 6.3); ctx.fill(); }
      ctx.globalAlpha = 1;
      drawConfetti(dt);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { alive = false; cancelAnimationFrame(raf); window.removeEventListener('resize', size); };
  }
  async function reopenDay() {
    const ok = await confirmDialog('Obnoviť príjem pacientov?', 'Tablet znova začne vydávať poradové čísla a oznam o ukončení dňa z obrazovky zmizne.', 'Obnoviť príjem');
    if (ok) act(() => api('/api/staff/day-end', { body: { ended: false } }), 'Príjem pacientov je opäť otvorený.');
  }

  // výber lekára kliknutím na meno v okne
  document.addEventListener('click', (e) => { const b = e.target.closest('button[data-nurse]'); if (b) { const i = document.getElementById('m-nurse'); if (i) { i.value = b.dataset.nurse; i.focus(); } } });
  document.addEventListener('click', (e) => { const b = e.target.closest('button[data-doc]'); if (b) { const i = document.getElementById('m-doc'); if (i) { i.value = b.dataset.doc; i.focus(); } } });

  /** v2.3: mimoriadny oznam – zobrazí sa na TV v čakárni, kým ho niektorá sestra nezruší. */
  async function announce() {
    const cur = S.staff.announcement;
    const presets = ['V oboch ambulanciách práve prebiehajú zákroky, preto sa vyšetrenia mierne oneskoria. Ďakujeme za pochopenie.',
      'Z dôvodu choroby jedného lekára dnes ordinuje iba jeden lekár. Počítajte, prosím, s dlhším čakaním. Ďakujeme za pochopenie.',
      'Z technických príčin sa ordinovanie oneskoruje. Ďakujeme za pochopenie.',
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
        </div>
        <div class="field" style="margin-top:14px"><label for="m-room">Ambulancia</label>${roomSelect(S.roomId)}</div>
        ${stageField('nurse')}
        ${identField(null)}
        <p class="hint">Podľa času objednania sa počíta poradie a časový sklz (teraz je ${esc(nowHm)}). Pacientovi povedzte (alebo napíšte) pridelené označenie. Na obrazovke v čakárni sa ukáže iba toto označenie a odchýlka od termínu.</p>`,
      onOk: async (root) => {
        if (S.conn !== 'online') throw new Error('Nie je spojenie so serverom.');
        if (!root.querySelector('#m-card').value.trim()) throw new Error('Zadajte číslo alebo písmeno pacienta.');
        if (!root.querySelector('#m-time').value) throw new Error('Zadajte čas objednania z kalendára – podľa neho sa počíta časový sklz.');
        return api('/api/staff/cards', { body: { cardNo: root.querySelector('#m-card').value, plannedTime: root.querySelector('#m-time').value || null, roomId: pickedRoom(root), stage: root.querySelector('#m-stage').value, ...identBody(root) } });
      },
    });
    if (res && res.ticket) toast(`Pacient ${res.ticket.code} zaradený${res.ticket.plannedAt ? ' na ' + fmtTime(res.ticket.plannedAt) : ''} – ${res.ticket.homeRoomName || 'všetky ambulancie'}`, 'ok');
  }

  /** 2026-11-16: výber ambulancie pacienta (prázdna hodnota = spoločný pacient pre všetky ambulancie). */
  function roomSelect(selId) {
    return `<select id="m-room">${roomsOpen(selId).map((r) => `<option value="${r.id}" ${r.id === selId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
      <option value="" ${selId == null ? 'selected' : ''}>Ktorákoľvek ambulancia (spoločný pacient)</option></select>`;
  }
  const pickedRoom = (root) => { const v = root.querySelector('#m-room').value; return v === '' ? null : Number(v); };

  /** 2026-11-16 (Pali): úprava čakajúceho pacienta – číslo, čas objednania a ambulancia (napr. pacienta prevezme druhá ambulancia). */
  async function editTicket(t) {
    if (!t) return;
    const cur = t.plannedAt ? fmtTime(t.plannedAt) : '';
    const res = await modal({
      title: `Upraviť pacienta ${t.code}`,
      okText: 'Uložiť',
      body: `<div class="row">
          <div class="field"><label for="m-card">Číslo alebo písmeno pacienta</label><input id="m-card" autocomplete="off" autocapitalize="characters" maxlength="6" value="${esc(t.code)}"></div>
          <div class="field"><label for="m-time">Čas objednania</label><input id="m-time" type="time" step="60" value="${esc(cur)}"></div>
        </div>
        <div class="field" style="margin-top:14px"><label for="m-room">Ambulancia</label>${roomSelect(t.homeRoomId)}</div>
        <p class="hint">Keď pacienta prevezme druhá ambulancia, vyberte ju tu – pacient sa presunie do jej zoznamu.</p>
        ${stageField(t.stage)}
        ${identField(t)}`,
      onOk: async (root) => {
        if (S.conn !== 'online') throw new Error('Nie je spojenie so serverom.');
        if (!root.querySelector('#m-card').value.trim()) throw new Error('Zadajte číslo alebo písmeno pacienta.');
        return api(`/api/staff/tickets/${t.id}/edit`, { body: { cardNo: root.querySelector('#m-card').value, plannedTime: root.querySelector('#m-time').value || null, roomId: pickedRoom(root), stage: root.querySelector('#m-stage').value, ...identBody(root) } });
      },
    });
    if (res && res.ticket) toast(`Uložené: ${res.ticket.code}${res.ticket.plannedAt ? ' · ' + fmtTime(res.ticket.plannedAt) : ''} · ${res.ticket.homeRoomName || 'ktorákoľvek ambulancia'}`, 'ok');
  }

  /**
   * 2026-11-23 (Pali): zmena ambulancie vyvolaného pacienta (u sestry, u lekára, na ukončení) – napr. pacient
   * musí ísť k inému lekárovi. Pacient odíde z ambulancie do čakárne a zaradí sa do radu vybranej ambulancie.
   */
  async function moveRoomTicket(t) {
    if (!t) return;
    const finishedT = t.status !== 'called';
    const opts = roomsActive().filter((r) => r.id !== t.roomId && (finishedT || !isClosed(r.id)));
    if (!opts.length) return toast('⚠ Iná ambulancia nie je – nie je kam pacienta presunúť.', 'error');
    const cur = finishedT || t.stage === 'final' ? 'here' : t.stage === 'nurse' ? 'nurse' : 'doctor';
    const where = finishedT ? `bol ${t.status === 'done' ? 'ukončený' : 'označený ako neprítomný'}` : t.stage === 'doctor' ? 'je teraz u lekára' : t.stage === 'final' ? 'je teraz u sestry na ukončení' : 'je teraz u sestry';
    const docName = (id) => (S.staff.doctors || {})[id];
    const res = await modal({
      title: `Zmeniť ambulanciu – ${t.code}`,
      okText: 'Zmeniť ambulanciu',
      body: `<p>Pacient ${where} v ambulancii <b>${esc(t.roomName || t.homeRoomName || '–')}</b>.</p>
        <div class="field" style="margin-top:14px"><label for="m-room">Nová ambulancia</label><select id="m-room">${opts.map((r, i) => `<option value="${r.id}" ${i === 0 ? 'selected' : ''}>${esc(r.name)}${docName(r.id) ? ' – ' + esc(docName(r.id)) : ''}</option>`).join('')}</select></div>
        <div class="field" style="margin-top:14px"><label for="m-stage">Čo s pacientom</label><select id="m-stage">
          ${finishedT ? '' : `<option value="doctor" ${cur === 'doctor' ? 'selected' : ''}>ide do čakárne a čaká na lekára novej ambulancie</option>
          <option value="nurse" ${cur === 'nurse' ? 'selected' : ''}>ide do čakárne a čaká na sestru novej ambulancie</option>`}
          <option value="here" ${cur === 'here' ? 'selected' : ''}>${finishedT ? 'bol v novej ambulancii – opraviť záznam' : 'už je v novej ambulancii – len opraviť'}</option></select></div>
        <p class="hint">${finishedT ? 'Ambulancia sa opraví v histórii aj v štatistikách (lekár a sestra podľa dnešného obsadenia novej ambulancie).'
          : 'Pri čakaní pacienta vyvolá nová ambulancia – na obrazovke sa ukáže jej číslo. Na lekára čaká podľa času, kedy ho sestra poslala k lekárovi. Pri oprave sa ambulancia zmení na kartičke, na obrazovke, v histórii aj v štatistikách.'}</p>`,
      onOk: async (root) => {
        if (S.conn !== 'online') throw new Error('Nie je spojenie so serverom.');
        return api(`/api/staff/tickets/${t.id}/room`, { body: { roomId: Number(root.querySelector('#m-room').value), stage: root.querySelector('#m-stage').value } });
      },
    });
    if (res && res.ticket) toast(res.ticket.status === 'waiting' ? `${res.ticket.code}: ${res.ticket.homeRoomName} – čaká na ${res.ticket.stage === 'doctor' ? 'lekára' : 'sestru'}`
      : `${res.ticket.code}: ambulancia opravená na ${res.ticket.roomName}`, 'ok');
  }

  /** 2026-11-17: identifikátor aj pre vyvolaného pacienta (úprava čakajúceho je v ✎ Upraviť). */
  async function noteTicket(t) {
    if (!t) return;
    const res = await modal({
      title: `Typ a identifikátor – ${t.code}`,
      okText: 'Uložiť',
      body: identField(t),
      onOk: async (root) => {
        if (S.conn !== 'online') throw new Error('Nie je spojenie so serverom.');
        return api(`/api/staff/tickets/${t.id}/note`, { body: identBody(root) });
      },
    });
    if (res && res.ticket) toast(hasPriv(res.ticket) ? `${res.ticket.code}: uložené` : `${res.ticket.code}: typ a identifikátor odstránené`, 'ok');
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
    const st2 = t.stage === 'doctor' ? 'doctor' : 'nurse';
    const waiting = S.staff.tickets.filter((x) => x.status === 'waiting' && (x.stage || 'nurse') === st2 && (showAll() || mineFilter(x))).sort(st2 === 'doctor' ? byDocOrder : byOrder);
    const outOfOrder = waiting.length && waiting[0].id !== t.id;
    // 2026-11-23 (Pali): pacient patrí inej ambulancii – vyvolanie ponúkne jeho ambulanciu, aby sa nezapísal do cudzej
    const rooms = roomsOpen(S.roomId);
    const other = t.homeRoomId && t.homeRoomId !== S.roomId && rooms.some((r) => r.id === t.homeRoomId) ? t.homeRoomId : null;
    if (!outOfOrder && !other) {
      return act(() => api(`/api/staff/tickets/${t.id}/call`, { body: { roomId: S.roomId } }), (r) => `Vyvolané ${r.ticket.code} – ${r.ticket.roomName}`);
    }
    const res = await modal({
      title: `Vyvolať ${t.code}`,
      okText: 'Vyvolať',
      body: `${outOfOrder ? `<p class="alert alert-info">Číslo nie je na rade (na rade je ${esc(waiting[0].code)}). Vyvolanie mimo poradia je v poriadku, napr. pre objednaného pacienta.</p>` : ''}
        ${other ? `<p class="alert alert-info">Pacient patrí do ambulancie <b>${esc(t.homeRoomName || '')}</b> – vyvolá sa tam. Ak ho naozaj prevezmete vy, vyberte svoju ambulanciu.</p>` : ''}
        <div class="field"><label for="m-room">Ambulancia</label><select id="m-room">${rooms.map((r) => `<option value="${r.id}" ${r.id === (other || S.roomId) ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
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
  const EV_TEXT = { created: 'Registrácia', planned: 'Plánovaný čas', call: 'Vyvolanie', recall: 'Zopakované vyvolanie', done: 'Ukončený', absent: 'Neprítomný',
    requeue: 'Vrátený medzi čakajúcich', to_doctor: 'Poslaný k lekárovi', to_nurse: 'Vrátený do radu k sestre', to_final: 'Od lekára k sestre na ukončenie', final_back: 'Z ukončenia späť k lekárovi', moved: 'Zmena ambulancie', edited: 'Zmena čísla', print: 'Tlač lístka', reprint: 'Opakovaná tlač', day_closed: 'Ukončenie dňa', display_cleared: 'Vyčistenie obrazovky' };

  /**
   * 2026-11-18 (Pali): priebeh v histórii presnejšie – kto pacienta vyvolal (sestra / lekár) a kto ho kam poslal.
   * Mená sú mená personálu z udalosti; `prev` = predchádzajúce udalosti toho istého čísla.
   */
  function evLine(e, prev) {
    const who = (n) => (n ? ` (${esc(n)})` : '');
    const room = e.roomName ? ' – ' + esc(e.roomName) : '';
    const lastStage = () => { for (let i = prev.length - 1; i >= 0; i--) { const t = prev[i].type;
      if (t === 'to_final') return 'final'; if (t === 'final_back' || t === 'to_doctor') return 'doctor'; if (t === 'to_nurse') return 'nurse';
      if ((t === 'call' || t === 'recall') && prev[i].stage) return prev[i].stage; } return null; };
    const wasCalled = () => { for (let i = prev.length - 1; i >= 0; i--) { const t = prev[i].type; if (t === 'call' || t === 'recall') return true; if (t === 'to_doctor' || t === 'requeue' || t === 'to_nurse') return false; } return false; };
    switch (e.type) {
      case 'created': return e.note === 'sestra' ? 'Pridaný sestrou' : 'Registrácia (lístok)';
      case 'call': case 'recall': {
        const again = e.type === 'recall' ? 'Zopakované vyvolanie ' : 'Vyvolaný ';
        const txt = e.stage === 'nurse' ? `${again}sestrou${who(e.nurse)}` : e.stage === 'doctor' ? `${again}lekárom${who(e.doctor)}` : (e.type === 'recall' ? 'Zopakované vyvolanie' : 'Vyvolanie');
        return txt + room + (e.note && e.type === 'call' ? ` <span class="ev-note">(${esc(e.note)})</span>` : '');
      }
      case 'to_doctor': return e.note === 'bez sestry' ? 'Zaradený rovno k lekárovi (bez sestry)' : 'Poslaný k lekárovi sestrou – čaká na lekára';
      case 'to_nurse': return 'Vrátený do radu k sestre';
      case 'to_final': return 'Poslaný k sestre lekárom – na ukončenie';
      case 'final_back': return 'Vrátený od sestry späť k lekárovi';
      case 'done': { const st = lastStage(), c = wasCalled();
        return st === 'final' ? 'Ukončený sestrou (po lekárovi)' : st === 'doctor' ? (c ? 'Ukončený u lekára' : 'Ukončený v rade k lekárovi (bez vyvolania)') : st === 'nurse' ? 'Ukončený sestrou (bez lekára)' : 'Ukončený'; }
      case 'absent': { const st = lastStage(); return 'Neprítomný' + (st === 'doctor' ? ' (pri lekárovi)' : st ? ' (pri sestre)' : ''); }
      default: return esc(EV_TEXT[e.type] || e.type) + (e.note && (e.type === 'day_closed' || e.type === 'moved' || e.type === 'edited') ? ` <span class="ev-note">(${esc(e.note)})</span>` : '');
    }
  }

  async function renderHistory() {
    $view.innerHTML = '<div class="center-msg">Načítava sa história…</div>';
    let days;
    try { days = (await api('/api/staff/days')).days; } catch (e) { handleError(e); $view.innerHTML = `<div class="center-msg">${esc(e.message)}</div>`; return; }
    if (!S.historyDay) S.historyDay = days.length ? days[0].day : (S.staff && S.staff.day);
    $view.innerHTML = `<div class="grid2" style="grid-template-columns:280px minmax(0,1fr)">
      <section class="card"><h2>Dni</h2><div class="daylist">${days.length ? days.map((d) => `<button class="btn ${d.day === S.historyDay ? 'active' : ''}" data-day="${esc(d.day)}">
        <span>${esc(fmtDay(d.day))}</span><span class="hint">${d.total} čísel${(d.waiting + d.called) && d.day !== (S.staff && S.staff.day) ? ` · <span class="open-badge">${d.waiting + d.called} neukončené</span>` : ''}</span></button>`).join('') : '<div class="empty">Žiadne záznamy.</div>'}</div></section>
      <section class="card" id="hist-detail"><div class="center-msg">Načítava sa…</div></section></div>`;
    $view.querySelectorAll('.daylist button').forEach((b) => { b.onclick = () => { S.historyDay = b.dataset.day; renderHistory(); }; });
    if (!S.historyDay) { document.getElementById('hist-detail').innerHTML = '<div class="empty">Žiadne záznamy.</div>'; return; }
    try {
      const h = await api('/api/staff/history?day=' + encodeURIComponent(S.historyDay));
      const payBy = {};
      for (const p of h.payments || []) payBy[p.ticketId] = p;
      const payHist = (p) => (p ? `<div class="pay-hist"><b>Úhrada ${esc(window.AdNaPeniaze.fmtEur(p.payableCents))}</b> ${p.method === 'cash' ? 'v hotovosti' : 'kartou'} · ${esc(p.companyName)} · potvrdila ${esc(p.confirmedBy || '–')} ${esc(fmtTime(p.confirmedAt))}
        <br>${p.items.map((i) => `${esc(i.name)} ${i.qty} × ${esc(window.AdNaPeniaze.fmtEur(i.unitCents))}`).join('; ')}
        <br>${p.receipt ? `${p.simulated ? 'SIMULÁCIA – nefiskalizované · ' : ''}doklad ID <b>${esc(p.receipt.id)}</b>${p.receipt.number ? ` · č. ${esc(p.receipt.number)}` : ''}` : ''} ${esc(p.status.text)}</div>` : '');
      const evBy = {};
      for (const e of h.events) (evBy[e.ticketId] = evBy[e.ticketId] || []).push(e);
      // 2026-11-24 (Pali): filter podľa ambulancie a semafor pri časoch vyvolania – zelená v čase (do 5 min), oranžová 6–15 min, červená tučne nad 15 min
      const roomOf = (t) => t.roomName || t.homeRoomName || '';
      const roomNames = [...new Set(h.tickets.map(roomOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'sk'));
      if (S.histRoom && !roomNames.includes(S.histRoom)) S.histRoom = '';
      const shown = S.histRoom ? h.tickets.filter((t) => roomOf(t) === S.histRoom) : h.tickets;
      const lateOf = (t, e) => Math.round((new Date(e.at).getTime() - Math.max(new Date(t.plannedAt || t.createdAt).getTime(), new Date(t.createdAt).getTime() || 0)) / 60000);
      const sem = (m) => (m > 15 ? 't-red' : m > 5 ? 't-amber' : 't-green');
      let nRed = 0, nAmber = 0, nGreen = 0;
      const evTime = (t, e, prev) => {
        const first = e.type === 'call' && !prev.some((p) => p.type === 'call' && (p.stage || '') === (e.stage || ''));
        if (!first || e.stage === 'final') return `<span class="ev-t">${esc(fmtTime(e.at))}</span>`;
        const m = lateOf(t, e), c = sem(m);
        if (e.stage === 'doctor' || !e.stage) { if (c === 't-red') nRed++; else if (c === 't-amber') nAmber++; else nGreen++; }
        const txt = m > 5 ? `+${fmtMin(m)}` : 'v čase';
        return `<span class="ev-t ${c}" title="${t.plannedAt ? 'Oproti termínu' : 'Od príchodu'} ${esc(fmtTime(t.plannedAt || t.createdAt))}">${esc(fmtTime(e.at))} (${txt})</span>`;
      };
      const rows = shown.map((t) => `<tr><td class="code">${esc(t.code)}</td><td><span class="badge b-${t.status}">${esc(STATUS_TEXT[t.status])}</span>${hasPriv(t) ? ' ' + identPill(t) : ''}</td>
        <td>${esc(fmtTime(t.createdAt))}</td><td>${t.roomName || t.homeRoomName ? ambPill(t.roomName ? t.roomId : t.homeRoomId, t.roomName || t.homeRoomName) : ''}</td><td>${printBadge(t.print)}</td>
        <td class="hint ev-list">${(evBy[t.id] || []).map((e, k, arr) => `${evTime(t, e, arr.slice(0, k))} ${ambColorText(evLine(e, arr.slice(0, k)))}`).join('<br>')}${payHist(payBy[t.id])}</td></tr>`).join('');
      const openPast = h.day !== (S.staff && S.staff.day) ? h.tickets.filter((t) => t.status === 'waiting' || t.status === 'called').length : 0;
      document.getElementById('hist-detail').innerHTML = `<div class="section-title"><h2>${esc(fmtDay(h.day))}</h2>
        <span class="hint">${shown.length} čísel${S.histRoom ? ` z ${h.tickets.length}` : ''}</span></div>
        ${roomNames.length > 1 ? `<div class="hist-filter" role="group" aria-label="Filter podľa ambulancie"><button class="btn ${!S.histRoom ? 'active' : ''}" data-hroom="">Všetky ambulancie</button>${roomNames.map((n) => `<button class="btn ${S.histRoom === n ? 'active' : ''}" data-hroom="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
        <p class="hint hist-legend">Čas vyvolania oproti termínu (pri neskorom príchode alebo bez termínu od príchodu): <span class="t-green">zelená = v čase (do 5 min)</span> · <span class="t-amber">oranžová = mešká 6 – 15 min</span> · <span class="t-red">červená = mešká viac ako 15 min</span>.
          K lekárovi: <span class="t-green">${nGreen} v čase</span>, <span class="t-amber">${nAmber} s malým meškaním</span>, <span class="t-red">${nRed} s veľkým meškaním</span>.</p>
        ${openPast ? `<div class="alert alert-warn"><div class="grow"><b>${openPast} neukončené čísla</b> z tohto dňa ostali v stave Čaká alebo Vyvolaný.
          Do nového dňa sa neprenášajú. Uzavretím ich označíte ako Neprítomný.</div>
          <button class="btn btn-danger" id="btn-close-past">Uzavrieť neukončené…</button></div>` : ''}
        ${shown.length ? `<table><thead><tr><th>Číslo</th><th>Stav</th><th>Príchod</th><th>Ambulancia</th><th>Lístok</th><th>Priebeh</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">V tento deň nie sú žiadne čísla.</div>'}`;
      document.querySelectorAll('#hist-detail [data-hroom]').forEach((b) => { b.onclick = () => { S.histRoom = b.dataset.hroom; renderHistory(); }; });
      const bc = document.getElementById('btn-close-past');
      if (bc) bc.onclick = () => modal({
        title: 'Uzavrieť neukončené čísla?', okText: 'Uzavrieť', okClass: 'btn-danger solid',
        body: `<p>${openPast} čísel z ${esc(fmtDay(h.day))} bude označených ako <b>Neprítomný</b>. Záznam o uzavretí ostane v histórii.</p>`,
        onOk: async () => {
          const r = await api('/api/staff/close-past-day', { body: { day: h.day } });
          toast(`Uzavretých čísel: ${r.closed} (označené ako Neprítomný).`, 'ok');
          renderHistory();
        },
      });
    } catch (e) { handleError(e); }
  }

  const KIND_TEXT = { staff: 'Sestra – konto ambulancie', nurse: 'Sestra – osobné konto', doctor: 'Lekár', admin: 'Správca' };
  const kindOf = (u) => (u.doctorName ? 'doctor' : u.nurseName ? 'nurse' : u.role === 'admin' ? 'admin' : 'staff');
  const kindSelect = (cls, cur, id) => `<select ${cls ? `class="${cls}"` : ''} ${id ? `id="${id}"` : ''} aria-label="Typ konta">${Object.entries(KIND_TEXT)
    .map(([k, t]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  const docSelect = (cls, cur, list, id, what = 'doc') => {
    const names = [...new Set([...(list || []), ...(cur ? [cur] : [])])];
    return `<select ${cls ? `class="${cls} u-${what}"` : `class="u-${what}"`} ${id ? `id="${id}"` : ''} aria-label="${what === 'nurse' ? 'Sestra' : 'Lekár'}">${names
      .map((n) => `<option value="${esc(n)}" ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  };

  // ---------- priebežný stav (2026-11-23) ----------
  const clock = () => new Date().toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  /** Koľko pacientov je práve kde – z aktuálneho stavu, ktorý chodí cez WebSocket. */
  function liveNow() {
    const ts = (S.staff && S.staff.tickets) || [];
    const w = ts.filter((t) => t.status === 'waiting'), c = ts.filter((t) => t.status === 'called');
    const oldest = (list, f) => { const xs = list.map(f).filter(Boolean).sort(); return xs.length ? Math.max(0, Math.round((Date.now() - new Date(xs[0]).getTime()) / 60000)) : null; };
    const wn = w.filter((t) => (t.stage || 'nurse') === 'nurse'), wd = w.filter((t) => t.stage === 'doctor');
    const k = (n, label, extra) => `<div class="stats-kpi live"><b>${n}</b><span>${label}${extra != null && n ? `<br>najdlhšie ${fmtMin(extra)}` : ''}</span></div>`;
    return `<section class="card live-now" id="live-now"><h2>Práve teraz</h2><div class="stats-kpis">
      ${k(wn.length, 'čaká na sestru', oldest(wn, (t) => t.createdAt))}
      ${k(c.filter((t) => t.stage !== 'doctor' && t.stage !== 'final').length, 'u sestry')}
      ${k(wd.length, 'čaká na lekára', oldest(wd, (t) => t.toDoctorAt))}
      ${k(c.filter((t) => t.stage === 'doctor').length, 'u lekára')}
      ${k(c.filter((t) => t.stage === 'final').length, 'u sestry na ukončení')}
      ${k(ts.filter((t) => t.status === 'done').length, 'ukončených dnes')}</div>${liveRooms(w, c)}</section>`;
  }
  /** 2026-11-24 (Pali): ktorá ambulancia je práve ako zaplnená a aké má aktuálne meškanie oproti termínom. */
  function liveRooms(w, c) {
    const room = (t) => t.roomName || t.homeRoomName || 'Bez ambulancie';
    const names = [...new Set([...w, ...c].map(room))].sort((a, b) => a.localeCompare(b, 'sk'));
    if (!names.length) return '';
    const now = Date.now();
    // aktuálne meškanie = ako dlho po termíne (alebo po neskoršom príchode) ešte pacient čaká na vstup k lekárovi
    const late = (t) => { if (!t.plannedAt) return null; const from = Math.max(new Date(t.plannedAt).getTime(), new Date(t.createdAt).getTime() || 0); return Math.round((now - from) / 60000); };
    const row = (n) => {
      const W = w.filter((t) => room(t) === n), C = c.filter((t) => room(t) === n);
      const wn = W.filter((t) => (t.stage || 'nurse') === 'nurse').length, wd = W.filter((t) => t.stage === 'doctor').length;
      const un = C.filter((t) => t.stage !== 'doctor' && t.stage !== 'final').length, ud = C.filter((t) => t.stage === 'doctor').length, uf = C.filter((t) => t.stage === 'final').length;
      const ls = [...W, ...C.filter((t) => t.stage !== 'doctor' && t.stage !== 'final')].map(late).filter((x) => x != null);
      const mx = ls.length ? Math.max(...ls) : null;
      const cell = (v) => `<td class="num">${v ? `<b>${v}</b>` : '<span class="hint">0</span>'}</td>`;
      return `<tr><td class="doc">${esc(n)} ${n === 'Bez ambulancie' ? '' : ud ? '<span class="badge-busy">obsadená – pacient u lekára</span>' : un || uf ? '<span class="badge-part">pacient u sestry</span>' : '<span class="badge-free">lekár voľný</span>'}</td>
        ${cell(wn)}${cell(un)}${cell(wd)}${cell(ud)}${cell(uf)}
        <td class="num">${mx == null ? '–' : mx > 5 ? `<b class="d-late">mešká ${fmtMin(mx)}</b>` : '<b class="d-ok">v čase</b>'}</td></tr>`;
    };
    return `<div class="stats-scroll" style="margin-top:12px"><table class="stats-table"><thead><tr><th>Ambulancia</th><th class="num">Čaká na sestru</th><th class="num">U sestry</th>
      <th class="num">Čaká na lekára</th><th class="num">U lekára</th><th class="num">Na ukončení</th><th class="num">Aktuálne meškanie</th></tr></thead><tbody>${names.map(row).join('')}</tbody></table></div>
      <p class="hint">Aktuálne meškanie = najdlhší čas po termíne, počas ktorého pacient tejto ambulancie ešte čaká na vstup k lekárovi (pri neskorom príchode sa počíta od príchodu).</p>`;
  }
  let liveTimer = null;
  function liveRefresh() {
    if (!S.user || document.hidden) return;
    const today = (S.staff && S.staff.day) || isoDay(new Date());
    if (S.view === 'stats' && S.statsTo >= today && document.getElementById('stats-out')) loadStats(true);
    else if (S.view === 'today' && document.getElementById('btn-today-refresh')) renderToday(true);
  }
  function liveStatsSoon() { clearTimeout(liveTimer); liveTimer = setTimeout(liveRefresh, 1500); }
  setInterval(liveRefresh, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) liveStatsSoon(); });

  // ---------- dnešné štatistiky (sestra) ----------
  async function renderToday(silent) {
    if (silent !== true) $view.innerHTML = '<div class="center-msg">Načítava sa…</div>';
    let r;
    try { r = await api('/api/staff/today-stats'); }
    catch (e) { if (silent === true) return; handleError(e); $view.innerHTML = `<div class="alert alert-danger"><div class="grow">${esc(e.message)}</div></div>`; return; }
    if (S.view !== 'today') return;
    const t = r.total;
    $view.innerHTML = `<div class="stack">
      <section class="card"><div class="section-title"><h2>Dnešné štatistiky – ${esc(fmtDay(r.day))}</h2><button class="btn btn-sm" id="btn-today-refresh">Obnoviť</button></div>
        <p class="hint">Len dnešný deň. Údaje sa počítajú z vyvolaných pacientov. <span class="live-stamp" id="live-stamp">● Aktualizované ${esc(clock())} – obnovuje sa automaticky</span></p></section>
      ${liveNow()}
      <section class="stats-kpis">
        <div class="stats-kpi"><b>${t.patients}</b><span>vyvolaných pacientov (čaká ešte ${r.waiting})</span></div>
        <div class="stats-kpi"><b>${t.done}</b><span>ukončených · ${t.absent} neprítomných</span></div>
        <div class="stats-kpi"><b>${mins(t.avgWait)}</b><span>priemerné čakanie od príchodu po sestru</span></div>
        <div class="stats-kpi">${delayHtml(t)}<span>priemerné meškanie oproti plánu</span></div>
        <div class="stats-kpi"><b>${mins(t.avgDoctorWait)}</b><span>priemerné čakanie na lekára</span></div>
        <div class="stats-kpi"><b>${pct(t.onTime, t.planned)}</b><span>vyvolaných načas (do 5 min)</span></div>
      </section>
      ${r.rooms.length ? `<section class="card"><h2>Podľa ambulancie</h2><div class="stats-scroll"><table class="stats-table"><thead><tr>
        <th>Ambulancia</th><th class="num">Pacienti</th><th class="num">Ukončení</th><th class="num">Neprítomní</th><th class="num">Ø čakanie</th>
        <th class="num">Ø meškanie</th><th class="num">Max. meškanie</th><th class="num">Načas</th><th class="num">Ø u sestry</th><th class="num">Ø čakanie na lekára</th><th class="num">Ø u lekára</th><th class="num">Ø celá návšteva</th></tr></thead><tbody>
        ${r.rooms.map((d) => `<tr><td class="doc">${esc(d.name)}</td><td class="num">${d.patients}</td><td class="num">${d.done}</td><td class="num">${d.absent}</td>
          <td class="num">${mins(d.avgWait)}</td><td class="num">${delayHtml(d)}</td>
          <td class="num">${d.planned ? mins(d.maxDelay) : '–'}</td><td class="num">${pct(d.onTime, d.planned)}</td>
          <td class="num">${mins(d.avgNurse)}</td><td class="num">${mins(d.avgDoctorWait)}</td><td class="num">${mins(d.avgDoctor)}</td><td class="num">${mins(d.avgExam)}</td></tr>`).join('')}
        </tbody></table></div>
        <p class="hint">Čakanie a meškanie = po vstup k sestre (čas objednania je čas vstupu k sestre). U sestry = od vyvolania po „K lekárovi“. Čakanie na lekára = od „K lekárovi“ po vyvolanie lekárom (priamo k lekárovi = 0). Celá návšteva = od vstupu k sestre po „Ukončený“.</p></section>` : '<section class="card"><div class="empty">Dnes zatiaľ nebol vyvolaný žiadny pacient.</div></section>'}</div>`;
    document.getElementById('btn-today-refresh').onclick = () => renderToday();
  }

  // ---------- môj prehľad (osobné konto lekára, od 2026-11-24 aj sestry) ----------
  async function renderMe() {
    const isDoc = !!S.user.doctorName;
    const myName = S.user.doctorName || S.user.nurseName;
    if (!myName) { $view.innerHTML = '<div class="center-msg">Prehľad je pre osobné konto lekára alebo sestry.</div>'; return; }
    const today = (S.staff && S.staff.day) || isoDay(new Date());
    if (!S.meTo) S.meTo = today;
    if (!S.meFrom) { const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() - 29); S.meFrom = isoDay(d); }
    $view.innerHTML = `<div class="stack">
      <section class="card stack"><div class="section-title"><h2>Môj prehľad – ${esc(myName)}</h2><span class="hint">Len pacienti, ktorých ste vybavili vy – aj keď sa v ambulancii počas dňa vystriedate s kolegom</span></div>
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
    catch (e) { handleError(e); document.getElementById('me-out').innerHTML = `<div class="alert alert-danger"><div class="grow">⚠ ${esc(e.message)}</div></div>`; return; }
    const out = document.getElementById('me-out');
    const t = r.summary;
    if (!t) { out.innerHTML = `<section class="card"><div class="empty">V tomto období ste zatiaľ ${isDoc ? 'nevyvolali' : 'neprijali'} žiadneho pacienta.</div></section>`; return; }
    const c = r.clinic;
    const kpis = isDoc ? `
        <div class="stats-kpi"><b>${t.patients}</b><span>vašich pacientov (ukončení ${t.done})<br>(všetci lekári spolu ${c.patients})</span></div>
        <div class="stats-kpi"><b>${mins(t.avgWait)}</b><span>priemerné čakanie pacienta na vás<br>(všetci spolu ${mins(c.avgWait)})</span></div>
        <div class="stats-kpi">${delayHtml(t)}<span>priemerné meškanie oproti termínu<br>(všetci spolu ${c.planned ? mins(c.avgDelay) : '–'})</span></div>
        <div class="stats-kpi"><b>${pct(t.onTime, t.planned)}</b><span>pacientov vyvolaných načas (do 5 min)</span></div>
        <div class="stats-kpi"><b>${mins(t.avgExam)}</b><span>priemerná dĺžka vyšetrenia u vás</span></div>` : `
        <div class="stats-kpi"><b>${t.patients}</b><span>vašich pacientov (ukončení ${t.done})<br>(všetky sestry spolu ${c.patients})</span></div>
        <div class="stats-kpi"><b>${mins(t.avgWait)}</b><span>priemerné čakanie pacienta na vás<br>(všetci spolu ${mins(c.avgWait)})</span></div>
        <div class="stats-kpi">${delayHtml(t)}<span>priemerné meškanie oproti termínu<br>(všetci spolu ${c.planned ? mins(c.avgDelay) : '–'})</span></div>
        <div class="stats-kpi"><b>${pct(t.onTime, t.planned)}</b><span>pacientov prijatých načas (do 5 min)</span></div>
        <div class="stats-kpi"><b>${mins(t.avgNurse)}</b><span>priemerný čas pacienta u vás</span></div>`;
    const cmpRow = (d, label, cls) => `<tr class="${cls || ''}"><td class="doc">${label}</td><td class="num">${d.patients}</td><td class="num">${mins(d.avgWait)}</td>
      <td class="num">${delayHtml(d)}</td><td class="num">${pct(d.onTime, d.planned)}</td><td class="num">${mins(d.avgExam)}</td></tr>`;
    const cmp = isDoc && r.othersAvg ? `<section class="card"><div class="section-title"><h2>Porovnanie s ostatnými lekármi</h2><span class="hint">Anonymne – mená ostatných lekárov nevidíte</span></div>
        <div class="stats-scroll"><table class="stats-table"><thead><tr><th>Lekár</th><th class="num">Pacienti</th><th class="num">Ø čakanie</th>
          <th class="num">Ø meškanie</th><th class="num">Načas</th><th class="num">Ø vyšetrenie</th></tr></thead><tbody>
          ${r.me ? cmpRow(r.me, 'Vy', 'me-row') : ''}
          ${cmpRow(r.othersAvg, `Ostatní lekári spolu <span class="hint">(${r.othersAvg.count})</span>`)}
          ${(r.comparison || []).length ? `<tr><td colspan="6" class="hint" style="padding-top:14px"><b>Jednotlivo</b> (poradie podľa meškania, najmenšie prvé)</td></tr>` + r.comparison.map((d) => cmpRow(d, `${d.rank}. ${esc(d.label)}`, d.me ? 'me-row' : '')).join('') : ''}
        </tbody></table></div>
        <p class="hint">„Ostatní lekári spolu“ = priemer za všetkých ich pacientov v tomto období. Jednotliví lekári (Lekár A, B…) sa ukazujú len vtedy, keď sú aspoň traja ďalší –
          pri menšom počte by sa dalo ľahko uhádnuť, o koho ide. Ambulancie sa neuvádzajú.</p>
      </section>` : '';
    out.innerHTML = `<div class="stack">
      <section class="stats-kpis">${kpis}</section>
      <section class="card"><h2>Po dňoch</h2><div class="stats-scroll"><table class="stats-table"><thead><tr>
        <th>Deň</th><th class="num">Pacienti</th><th class="num">Ukončení</th><th class="num">Neprítomní</th><th class="num">Ø čakanie</th>
        <th class="num">Ø meškanie</th><th class="num">Max. meškanie</th><th class="num">Načas</th><th class="num">${isDoc ? 'Ø vyšetrenie' : 'Ø u vás'}</th></tr></thead><tbody>
        ${r.days.map((d) => `<tr><td class="doc">${esc(fmtDay(d.day))}</td><td class="num">${d.patients}</td><td class="num">${d.done}</td><td class="num">${d.absent}</td>
          <td class="num">${mins(d.avgWait)}</td><td class="num">${delayHtml(d)}</td><td class="num">${d.planned ? mins(d.maxDelay) : '–'}</td>
          <td class="num">${pct(d.onTime, d.planned)}</td><td class="num">${mins(isDoc ? d.avgExam : d.avgNurse)}</td></tr>`).join('')}</tbody></table></div>
        <p class="hint">${isDoc ? `Čakanie = od chvíle, keď pacienta sestra poslala k lekárovi, po vaše vyvolanie (priamo k lekárovi = 0).
          Vyšetrenie = od vášho vyvolania po „Ukončený“. Meškanie = vstup vášho pacienta k sestre oproti termínu (ak prišiel neskôr, počíta sa od príchodu).`
          : `Čakanie = od príchodu pacienta po vaše vyvolanie. Meškanie = vaše vyvolanie oproti termínu (ak prišiel neskôr, počíta sa od príchodu).
          Čas u vás = od vyvolania po „K lekárovi“ (alebo „Ukončený“).`}
          Pacient sa počíta tomu, kto bol prihlásený, keď ho vyvolal – pri striedaní v tej istej ambulancii má každý svoje čísla.</p>
      </section>
      ${cmp}</div>`;
  }

  // ---------- štatistiky lekárov (len správca) ----------
  const isoDay = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Bratislava' }).format(d);
  /** 2026-11-23 (Pali): priemer oproti termínu – meškanie červeným, v čase čiernym, predstih (nadbehnuté) zeleným; vždy tučne a s textom. */
  const delayHtml = (d) => {
    if (!d || !d.planned) return '<b>–</b>';
    const v = d.avgDiff != null ? d.avgDiff : d.avgDelay;
    if (v > 0) return `<b class="d-late" title="Priemerné meškanie oproti termínu">mešká ${mins(v)}</b>`;
    if (v < 0) return `<b class="d-early" title="Priemerne skôr, než bol termín">predstih ${mins(-v)}</b>`;
    return '<b class="d-ok" title="Priemerne presne podľa termínu">v čase</b>';
  };
  const docDelayHtml = (d) => { if (!d || !d.docPlanned) return '<b>–</b>'; const v = d.avgDocDiff; return v > 0 ? `<b class="d-late" title="Priemerné meškanie vstupu k lekárovi oproti termínu">mešká ${mins(v)}</b>` : v < 0 ? `<b class="d-early">predstih ${mins(-v)}</b>` : '<b class="d-ok">v čase</b>'; };
  const mins = (m) => (m == null ? '–' : m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + ' %' : '–');

  async function renderStats() {
    if (S.user.role !== 'admin') { $view.innerHTML = '<div class="center-msg">Štatistiky vidí len správca.</div>'; return; }
    const today = (S.staff && S.staff.day) || isoDay(new Date());
    if (!S.statsTo) S.statsTo = today;
    if (!S.statsFrom) { const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() - 29); S.statsFrom = isoDay(d); }
    $view.innerHTML = `<div class="stack">
      <section class="card stack"><div class="section-title"><h2>Štatistiky</h2><span class="hint">Vidí len správca</span></div>
        <div class="row" role="group" aria-label="Zobraziť podľa" style="gap:8px;flex-wrap:wrap">${[['doctor', 'Lekári'], ['nurse', 'Sestry'], ['room', 'Ambulancie']].map(([k, l]) =>
          `<button class="btn btn-sm ${(S.statsGroup || 'doctor') === k ? 'btn-primary' : ''}" type="button" data-group="${k}">${l}</button>`).join('')}</div>
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
    $view.querySelectorAll('[data-group]').forEach((b) => { b.onclick = () => { S.statsGroup = b.dataset.group; renderStats(); }; });
    const grp = S.statsGroup || 'doctor';
    form.querySelectorAll('[data-range]').forEach((b) => { b.onclick = () => {
      const d = new Date(today + 'T12:00:00');
      if (b.dataset.range === 'month') d.setDate(1); else d.setDate(d.getDate() - Number(b.dataset.range));
      S.statsFrom = isoDay(d); S.statsTo = today; renderStats();
    }; });
    await loadStats(false);
  }

  /** 2026-11-23 (Pali): priebežné štatistiky – keď obdobie siaha po dnešok, tabuľka sa obnovuje sama (pri každej zmene a raz za minútu). */
  async function loadStats(silent) {
    const today = (S.staff && S.staff.day) || isoDay(new Date());
    const grp = S.statsGroup || 'doctor';
    const live = S.statsTo >= today;
    const key = `${S.statsFrom}|${S.statsTo}|${grp}`;
    let r;
    try { r = await api(`/api/admin/stats?from=${encodeURIComponent(S.statsFrom)}&to=${encodeURIComponent(S.statsTo)}&groupBy=${grp}`); }
    catch (e) { if (silent) return; handleError(e); const o = document.getElementById('stats-out'); if (o) o.innerHTML = `<div class="alert alert-danger"><div class="grow">${esc(e.message)}</div></div>`; return; }
    const out = document.getElementById('stats-out');
    if (S.view !== 'stats' || !out || key !== `${S.statsFrom}|${S.statsTo}|${S.statsGroup || 'doctor'}`) return;
    const t = r.total;
    const head = live ? `<p class="hint live-stamp" id="live-stamp">● Aktualizované ${esc(clock())} – obnovuje sa automaticky</p>${liveNow()}` : '';
    if (!t.patients) { out.innerHTML = `<div class="stack">${head}<section class="card"><div class="empty">V tomto období nebol vyvolaný žiadny pacient.</div></section></div>`; return; }
    const row = (d, cls = '') => `<tr class="${cls}"><td class="doc">${esc(d.doctor)}${d.rooms && d.rooms.length && !cls ? `<div class="hint">${esc(d.rooms.join(', '))}</div>` : ''}</td>
      <td class="num">${d.days}</td><td class="num">${d.patients}</td><td class="num">${d.done}</td><td class="num">${d.absent}${d.open ? ` <span class="hint">(+${d.open} nevyb.)</span>` : ''}</td>
      <td class="num">${mins(d.avgWait)}</td><td class="num">${mins(d.medianWait)}</td>
      <td class="num">${d.planned}</td><td class="num">${delayHtml(d)}</td><td class="num">${d.planned ? mins(d.maxDelay) : '–'}</td>
      <td class="num">${pct(d.onTime, d.planned)}</td><td class="num ${d.late15 ? 'bad' : ''}">${d.planned ? d.late15 : '–'}</td>
      ${grp !== 'nurse' ? `<td class="num">${docDelayHtml(d)}</td><td class="num">${d.docPlanned ? mins(d.maxDocDelay) : '–'}</td><td class="num ${d.docLate15 ? 'bad' : ''}">${d.docPlanned ? d.docLate15 : '–'}</td>` : ''}
      <td class="num">${mins(d.avgExam)}</td>${grp === 'room' ? `<td class="num">${mins(d.avgNurse)}</td><td class="num">${mins(d.avgDoctorWait)}</td><td class="num">${mins(d.avgDoctor)}</td>` : ''}</tr>`;
    const G = { doctor: { who: 'Lekár', wait: 'Ø čakanie na lekára', exam: 'Ø u lekára' }, nurse: { who: 'Sestra', wait: 'Ø čakanie', exam: 'Ø u sestry' },
      room: { who: 'Ambulancia', wait: 'Ø čakanie', exam: 'Ø celá návšteva' } }[grp];
    out.innerHTML = `<div class="stack">${head}
      <section class="stats-kpis">
        <div class="stats-kpi"><b>${t.patients}</b><span>vyvolaných pacientov</span></div>
        <div class="stats-kpi"><b>${mins(t.avgWait)}</b><span>priemerné čakanie od príchodu</span></div>
        <div class="stats-kpi">${delayHtml(t)}<span>priemerné meškanie vstupu k sestre oproti termínu</span></div>
        ${grp !== 'nurse' ? `<div class="stats-kpi">${docDelayHtml(t)}<span>priemerné meškanie vstupu k lekárovi oproti termínu${t.docPlanned ? ` (najviac ${mins(t.maxDocDelay)})` : ''}</span></div>` : ''}
        <div class="stats-kpi"><b>${pct(t.onTime, t.planned)}</b><span>pacientov s plánom vyvolaných načas (do 5 min)</span></div>
        <div class="stats-kpi"><b>${mins(t.avgExam)}</b><span>priemerná dĺžka vyšetrenia</span></div>
      </section>
      <section class="card"><div class="stats-scroll"><table class="stats-table"><thead><tr>
        <th>${G.who}</th><th class="num">Dni</th><th class="num">Pacienti</th><th class="num">Ukončení</th><th class="num">Neprítomní</th>
        <th class="num">${G.wait}</th><th class="num">Medián čak.</th>
        <th class="num">S plán. časom</th><th class="num">Ø mešk. k sestre</th><th class="num">Max. k sestre</th><th class="num">Načas</th><th class="num">K sestre &gt; 15 min</th>
        ${grp !== 'nurse' ? '<th class="num">Ø mešk. k lekárovi</th><th class="num">Max. k lekárovi</th><th class="num">K lekárovi &gt; 15 min</th>' : ''}
        <th class="num">${G.exam}</th>${grp === 'room' ? '<th class="num">Ø u sestry</th><th class="num">Ø čak. na lekára</th><th class="num">Ø u lekára</th>' : ''}</tr></thead>
        <tbody>${r.doctors.map((d) => row(d)).join('')}${r.doctors.length > 1 ? row({ ...t, doctor: 'Spolu' }, 'total') : ''}</tbody></table></div>
        <p class="hint">${r.twoStepSince ? `Od ${esc(fmtDay(r.twoStepSince))} má návšteva dva kroky – najprv sestra (čas objednania = vstup k sestre), potom lekár.
          Lekárovi sa počíta čakanie od „K lekárovi“ po jeho vyvolanie a čas u neho. <b>Meškanie k sestre</b> = vstup pacienta k sestre oproti termínu, <b>meškanie k lekárovi</b> = vyvolanie lekárom oproti termínu (ak pacient prišiel neskôr, od príchodu) – to je meškanie, ktoré pacient reálne pocíti. Priemer zahŕňa aj pacientov vzatých skôr (predstih ho znižuje), preto pozri aj maximum a počet nad 15 min.
          Pacient ukončený len u sestry sa lekárovi nepočíta. ` : ''}Staršie dni: čakanie = od príchodu (lístok/kartička) po prvé vyvolanie. Meškanie = prvé vyvolanie oproti plánovanému času (ak pacient prišiel neskôr, počíta sa od príchodu) – rovnako ako na TV.
          Vyšetrenie = od vyvolania po „Ukončený“. Lekár sa berie z ambulancie, ktorú sestra mala v čase vyvolania nastavenú.
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
        <p class="hint"><b>Typ konta:</b> Sestra – konto ambulancie – pridáva a vyvoláva pacientov, sestru treba vybrať tlačidlom „Zadať sestru“.
          Sestra – osobné konto – to isté, ale pacienti a štatistiky sa viažu na túto sestru a vidí „Môj prehľad“.
          Lekár – vyvoláva a vybavuje pacientov, nepridáva ich, vidí „Môj prehľad“ (svoje čísla a anonymné porovnanie s ostatnými lekármi).
          Keď sa lekári (sestry) počas dňa v ambulancii vystriedajú, každý má vlastné štatistiky – podľa toho, kto je prihlásený.
          Správca – navyše Nastavenia a Štatistiky všetkých lekárov.</p>
        <table id="tbl-users"><thead><tr><th>Konto</th><th>Typ</th><th>Meno (lekár / sestra)</th><th>Pracovisko</th><th>Aktívne</th><th>Nové heslo</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr data-user="${u.id}"><td><b>${esc(u.username)}</b></td>
          <td>${kindSelect('u-kind', kindOf(u))}</td>
          <td>${docSelect('u-doc', u.doctorName, s.doctorList)}${docSelect('u-nurse', u.nurseName, s.nurseList, null, 'nurse')}</td>
          <td><select class="u-room"><option value="">všetky</option>${rooms.filter((r) => r.active).map((r) => `<option value="${r.id}" ${r.id === u.roomId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></td>
          <td><input type="checkbox" class="u-active" ${u.active ? 'checked' : ''} style="width:20px;height:20px"></td>
          <td><input type="password" class="u-pw" placeholder="${u.noPassword ? 'nastaviť heslo' : 'ponechať'}" autocomplete="new-password" style="width:150px">${u.noPassword ? '<div class="hint" style="margin:4px 0 0"><b>⚠ Bez hesla</b> – prihlásenie nejde, kým ho nenastavíte.</div>' : ''}</td>
          <td class="actions"><button class="btn btn-sm btn-primary" data-user-save="${u.id}">Uložiť</button></td></tr>`).join('')}
        </tbody></table>
        <form class="row" id="f-user">
          <input type="text" id="nu-name" placeholder="meno konta, napr. ambulancia1" title="Malé písmená bez diakritiky a medzier" maxlength="30" autocapitalize="none" style="min-width:220px">
          <select id="nu-room">${rooms.filter((r) => r.active).map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}<option value="">všetky pracoviská</option></select>
          <input type="password" id="nu-pw" placeholder="heslo (aspoň 10 znakov)" autocomplete="new-password">
          ${kindSelect('', 'staff', 'nu-kind')}
          ${docSelect('', null, s.doctorList, 'nu-doc')}
          ${docSelect('', null, s.nurseList, 'nu-nurse', 'nurse')}
          <button class="btn btn-primary" type="submit">Pridať konto</button></form>
        <div class="row"><button class="btn" type="button" id="btn-bulk-users">Založiť kontá pre ambulancie, lekárov a sestry…</button>
          <span class="hint">Vytvorí chýbajúce kontá (ambulancia1, ambulancia2 … a lekárov aj sestry podľa priezviska) s náhodnými heslami, ktoré uvidíte len vy.</span></div>
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
        <div class="field vol-field"><label for="s-vol">Hlasitosť vyvolania na TV: <b id="s-vol-val">${s.soundVolume ?? 150} %</b></label>
          <div class="vol-row"><span aria-hidden="true">🔈</span><input type="range" id="s-vol" min="10" max="200" step="10" value="${s.soundVolume ?? 150}"><span aria-hidden="true">🔊</span>
            <button class="btn btn-sm" type="button" id="s-vol-test">Vyskúšať na TV</button></div>
          <span class="hint">100 % = pôvodná hlasitosť. Zvukový signál sa dá zosilniť až na 200 %, hlas hlásenia najviac na 100 % (viac nedovolí prehliadač) –
            ak je hlas stále tichý, zvýšte hlasitosť na televízore. „Vyskúšať na TV“ zahrá signál a hlásenie s hodnotou z posuvníka.</span></div>
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
        <div class="field"><label for="tv-nurses">Sestry na výber (jedna na riadok) – fotka sa hľadá podľa priezviska v assets/doctors, inak ilustrácia „Sestra“</label>
          <textarea id="tv-nurses" rows="4">${esc((s.nurseList || []).join('\n'))}</textarea></div>
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

      <section class="card stack" id="sec-billing"><h2>Platby pacientov a pokladnice VRP2</h2><div class="center-msg">Načítava sa…</div></section>

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
        <p class="hint">Bežné „Ukončiť deň“ (tablet prestane vydávať čísla, TV ukáže oznam) je tlačidlo 🏁 v Zozname.</p>
        <div class="row"><button class="btn btn-danger" id="btn-close-day">Uzavrieť dnešné neukončené čísla…</button></div>
        <p>Vymazanie údajov je nevratné. Zvoľte rozsah: história (všetky dni okrem dneška) alebo všetky čísla vrátane dneška.</p>
        <div class="row"><button class="btn btn-danger" id="btn-purge">Vymazať údaje…</button></div>
      </section>
    </div>`;
    refreshAdminBadges();
    POK.renderAdmin(document.getElementById('sec-billing'), payCtx);

    const saveSettings = async (patch, msg) => {
      try { await api('/api/admin/settings', { method: 'PUT', body: patch }); toast(msg, 'ok'); }
      catch (e) { handleError(e); }
    };
    document.getElementById('f-general').onsubmit = (e) => {
      e.preventDefault();
      saveSettings({
        clinicName: val('s-name'), ticketPrefix: val('s-prefix'), ticketDisplaySeconds: Number(val('s-secs')),
        recentCount: Number(val('s-recent')), ticketInstruction: val('s-instr'), soundEnabled: chk('s-sound'), soundVolume: Number(val('s-vol')),
      }, 'Nastavenia boli uložené.');
    };
    const vol = document.getElementById('s-vol');
    vol.oninput = () => { document.getElementById('s-vol-val').textContent = vol.value + ' %'; };
    document.getElementById('s-vol-test').onclick = async () => {
      try {
        const r = await api('/api/admin/sound-test', { body: { volume: Number(vol.value) } });
        toast(r.screens ? `Skúšobné vyvolanie zahrané na TV (${vol.value} %). Hodnotu uložte tlačidlom „Uložiť nastavenia“.` : '⚠ Obrazovka v čakárni nie je pripojená – skúšku nebolo kam poslať.', r.screens ? 'ok' : 'error');
      } catch (e) { handleError(e); }
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
      saveSettings({ doctorList: val('tv-doctors').split('\n').map((l) => l.trim()).filter(Boolean), nurseList: val('tv-nurses').split('\n').map((l) => l.trim()).filter(Boolean), queueCount: Number(val('tv-queue')), onTimeMinutes: Number(val('tv-tol')), tvSource: val('tv-src'),
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

    const nuName = document.getElementById('nu-name');
    nuName.oninput = () => { const c = cleanUsername(nuName.value); if (c !== nuName.value) nuName.value = c; };
    document.getElementById('f-user').onsubmit = async (e) => {
      e.preventDefault();
      if (val('nu-name').length < 3) { toast('Meno konta musí mať aspoň 3 znaky (napr. ambulancia1).', 'error'); nuName.focus(); return; }
      if (document.getElementById('nu-pw').value.length < 10) { toast('Heslo musí mať aspoň 10 znakov.', 'error'); document.getElementById('nu-pw').focus(); return; }
      try {
        await api('/api/admin/users', { body: { username: val('nu-name'), password: val('nu-pw'), roomId: val('nu-room') ? Number(val('nu-room')) : null, role: val('nu-kind') === 'admin' ? 'admin' : 'staff',
          doctorName: val('nu-kind') === 'doctor' ? val('nu-doc') : null, nurseName: val('nu-kind') === 'nurse' ? val('nu-nurse') : null } });
        toast('Konto bolo vytvorené.', 'ok'); renderAdmin();
      } catch (e2) { handleError(e2); }
    };
    document.getElementById('btn-bulk-users').onclick = () => bulkUsers(users, rooms.filter((r) => r.active), s.doctorList || [], s.nurseList || []);
    $view.querySelectorAll('[data-user-save]').forEach((b) => { b.onclick = async () => {
      const tr = b.closest('tr');
      const body = { roomId: tr.querySelector('.u-room').value ? Number(tr.querySelector('.u-room').value) : null,
        role: tr.querySelector('.u-kind').value === 'admin' ? 'admin' : 'staff', active: tr.querySelector('.u-active').checked,
        doctorName: tr.querySelector('.u-kind').value === 'doctor' ? tr.querySelector('.u-doc').value : null,
        nurseName: tr.querySelector('.u-kind').value === 'nurse' ? tr.querySelector('.u-nurse').value : null };
      const pw = tr.querySelector('.u-pw').value; if (pw) body.password = pw;
      try { await api('/api/admin/users/' + b.dataset.userSave, { method: 'PUT', body }); toast('Konto bolo uložené.', 'ok'); renderAdmin(); } catch (e2) { handleError(e2); }
    }; });
    // výber lekára má zmysel len pri type „Lekár“
    const syncDoc = (kindEl, docEl, nurseEl) => { const f = () => { docEl.hidden = kindEl.value !== 'doctor'; nurseEl.hidden = kindEl.value !== 'nurse'; }; kindEl.onchange = f; f(); };
    $view.querySelectorAll('#tbl-users tr[data-user]').forEach((tr) => syncDoc(tr.querySelector('.u-kind'), tr.querySelector('.u-doc'), tr.querySelector('.u-nurse')));
    syncDoc(document.getElementById('nu-kind'), document.getElementById('nu-doc'), document.getElementById('nu-nurse'));
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
      title: 'Uzavrieť dnešné neukončené čísla?', okText: 'Uzavrieť', okClass: 'btn-danger solid',
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
