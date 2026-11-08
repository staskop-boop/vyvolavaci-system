// Tablet pre pacientov – AdNa. Anonymná registrácia do poradia.
(function () {
  'use strict';
  const { api, uuid, connect } = window.AdNa;
  const $ = (id) => document.getElementById(id);
  const PENDING_KEY = 'adna.tablet.pending';
  const RETRY_DELAYS = [1000, 2000, 4000];      // automatické opakovanie pri výpadku spojenia
  const PENDING_MAX_AGE_MS = 5 * 60 * 1000;     // nedokončená požiadavka sa po 5 min zahodí

  let config = { ticketDisplaySeconds: 15, ticketInstruction: 'Posaďte sa, prosím, a sledujte obrazovku v čakárni.' };
  let locked = false;            // tlačidlo je zablokované počas spracovania a krátko po návrate
  let countdownTimer = null;

  // ---------- pomocné ----------
  function show(name) {
    for (const s of ['start', 'busy', 'result', 'error']) $('screen-' + s).hidden = s !== name;
  }
  function deviceId() {
    try { if (window.AdNaNative && AdNaNative.getDeviceId) return String(AdNaNative.getDeviceId()).slice(0, 60); } catch {}
    try {
      let d = localStorage.getItem('adna.tablet.deviceId');
      if (!d) { d = 'tablet-' + uuid().slice(0, 8); localStorage.setItem('adna.tablet.deviceId', d); }
      return d;
    } catch { return 'tablet'; }
  }
  function loadPending() {
    try {
      const p = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
      if (p && p.requestId && Date.now() - p.startedAt < PENDING_MAX_AGE_MS) return p;
    } catch {}
    clearPending();
    return null;
  }
  function savePending(p) { try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch {} }
  function clearPending() { try { sessionStorage.removeItem(PENDING_KEY); } catch {} }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function loadConfig() {
    try {
      const c = await api('/api/public/config', { timeoutMs: 5000 });
      config = { ...config, ...c };
      if (c.ticketInstruction) $('instruction').textContent = c.ticketInstruction;
    } catch { /* ponecháme posledné známe nastavenia */ }
  }

  // ---------- registrácia ----------
  async function register(resume) {
    if (locked && !resume) return;
    locked = true;
    $('btn-register').disabled = true;
    let pending = loadPending();
    if (!pending) { pending = { requestId: uuid(), startedAt: Date.now() }; savePending(pending); }
    show('busy');
    $('busy-text').textContent = 'Prideľujem poradové číslo…';

    for (let attempt = 0; ; attempt++) {
      try {
        const r = await api('/api/kiosk/tickets', {
          body: { requestId: pending.requestId, deviceId: deviceId() },
          timeoutMs: 20000, // server môže čakať na tlačiareň
        });
        clearPending();
        showResult(r);
        return;
      } catch (e) {
        const transient = e.status === 0 || e.status >= 500;
        if (transient && attempt < RETRY_DELAYS.length) {
          $('busy-text').textContent = 'Spojenie sa obnovuje, skúšam znova…';
          await sleep(RETRY_DELAYS[attempt]);
          continue;
        }
        if (!transient) clearPending(); // požiadavka bola odmietnutá – ďalší pokus dostane nový identifikátor
        showError(e, transient);
        return;
      }
    }
  }

  function showError(e, transient) {
    $('error-text').textContent = transient
      ? 'Nepodarilo sa spojiť so serverom.'
      : (e.code === 'RATE_LIMITED' ? 'Príliš veľa pokusov naraz.' : 'Registrácia sa nepodarila.');
    $('error-detail').textContent = transient
      ? 'Skúste to, prosím, znova o chvíľu. Ak problém pretrváva, obráťte sa na sestru.'
      : (e.message || 'Skúste to, prosím, znova. Ak problém pretrváva, obráťte sa na sestru.');
    show('error');
  }

  const PRINT_LINES = {
    ok: ['ok', 'Lístok sa tlačí, vezmite si ho.'],
    unverified: ['unverified', 'Ak sa lístok nevytlačil, zapamätajte si číslo alebo sa obráťte na sestru.'],
    failed: ['failed', 'Lístok sa nepodarilo vytlačiť. Zapamätajte si, prosím, svoje číslo. Sestra je informovaná.'],
    pending: ['unverified', 'Ak sa lístok nevytlačil, zapamätajte si číslo alebo sa obráťte na sestru.'],
    disabled: ['unverified', 'Zapamätajte si, prosím, svoje číslo.'],
  };

  function showResult(r) {
    $('ticket-code').textContent = r.ticket.code;
    const [cls, text] = PRINT_LINES[r.print && r.print.status] || PRINT_LINES.unverified;
    const ps = $('print-status');
    ps.className = 'print-status ' + cls;
    ps.textContent = text;
    show('result');
    let left = Math.max(5, Number(config.ticketDisplaySeconds) || 15);
    const tick = () => { $('countdown').textContent = `Obrazovka sa vráti na začiatok o ${left} s.`; };
    tick();
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => { left--; if (left <= 0) backToStart(); else tick(); }, 1000);
  }

  function backToStart() {
    clearInterval(countdownTimer);
    countdownTimer = null;
    show('start');
    // Krátka ochranná pauza, aby dotyk na „Hotovo“ nespustil hneď novú registráciu.
    setTimeout(() => { locked = false; $('btn-register').disabled = false; }, 800);
  }

  // ---------- udalosti ----------
  // pointerdown reaguje hneď pri dotyku; „locked“ zabráni opakovaným aj dlhým stlačeniam.
  $('btn-register').addEventListener('pointerdown', (e) => { e.preventDefault(); register(false); });
  $('btn-register').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); register(false); } });
  $('btn-done').addEventListener('click', backToStart);
  $('btn-retry').addEventListener('click', () => register(true));
  $('btn-cancel').addEventListener('click', () => { clearPending(); backToStart(); });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault());

  // Nenápadný indikátor spojenia (upozornenie až po 3 s výpadku).
  let offlineTimer = null;
  connect('display', {
    onMessage: (m) => { if (m.type === 'display.state' && m.state && m.state.clinicName) { /* stav nepotrebujeme */ } },
    onStatus: (s) => {
      if (s === 'online') { clearTimeout(offlineTimer); offlineTimer = null; $('offline').hidden = true; loadConfig(); }
      else if (!offlineTimer && $('offline').hidden) offlineTimer = setTimeout(() => { $('offline').hidden = false; }, 3000);
    },
  });

  setInterval(loadConfig, 60000);
  loadConfig().then(() => {
    // Ak sa stránka obnovila uprostred registrácie, dokončíme TÚ ISTÚ požiadavku (žiadne nové číslo).
    if (loadPending()) register(true); else show('start');
  });
})();
