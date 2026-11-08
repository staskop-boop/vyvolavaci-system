// Spoločná klientska knižnica AdNa pre webové časti aplikácií (tablet, sestra, obrazovka).
// Bez závislostí. Načítanie: <script src="/shared/adna-client.js"></script> → window.AdNa
(function () {
  'use strict';

  /** Základná adresa servera: rovnaký pôvod ako stránka (aplikácie sú servírované zo servera). */
  const base = '';

  class ApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }

  /**
   * Volanie API s časovým limitom. Pri sieťovej chybe vyhodí ApiError(0, 'NETWORK', ...).
   * @param {string} path
   * @param {{method?:string, body?:any, timeoutMs?:number}} [opt]
   */
  async function api(path, opt = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opt.timeoutMs || 10000);
    let res;
    try {
      res = await fetch(base + path, {
        method: opt.method || (opt.body !== undefined ? 'POST' : 'GET'),
        headers: opt.body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined,
        credentials: 'same-origin',
        signal: ctrl.signal,
        cache: 'no-store',
      });
    } catch (e) {
      throw new ApiError(0, 'NETWORK', ctrl.signal.aborted
        ? 'Server neodpovedá. Skontrolujte pripojenie k sieti.'
        : 'Nepodarilo sa spojiť so serverom. Skontrolujte pripojenie k sieti.');
    } finally { clearTimeout(t); }
    let data = null;
    try { data = await res.json(); } catch { /* prázdne telo */ }
    if (!res.ok) {
      const e = data && data.error;
      throw new ApiError(res.status, (e && e.code) || 'HTTP_' + res.status, (e && e.message) || 'Nastala chyba (' + res.status + ').');
    }
    return data;
  }

  /**
   * WebSocket s automatickým opätovným pripojením a kontrolou živosti.
   * @param {'display'|'staff'} channel
   * @param {{onMessage:(msg:any)=>void, onStatus?:(s:'connecting'|'online'|'offline')=>void, onUnauthorized?:()=>void}} h
   */
  function connect(channel, h) {
    let ws = null, retry = 0, lastMsg = 0, stopped = false, timer = null, watchdog = null;
    const status = (s) => h.onStatus && h.onStatus(s);

    function open() {
      if (stopped) return;
      status('connecting');
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      try { ws = new WebSocket(proto + '//' + location.host + '/ws?channel=' + channel); }
      catch { schedule(); return; }
      ws.onopen = () => { retry = 0; lastMsg = Date.now(); status('online'); };
      ws.onmessage = (ev) => {
        lastMsg = Date.now();
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'ping') { try { ws.send('{"type":"pong"}'); } catch {} return; }
        if (m.type === 'pong') return;
        h.onMessage(m);
      };
      ws.onclose = (ev) => {
        ws = null;
        if (ev.code === 4401) { status('offline'); h.onUnauthorized && h.onUnauthorized(); return; }
        status('offline');
        schedule();
      };
      ws.onerror = () => { try { ws && ws.close(); } catch {} };
    }
    function schedule() {
      if (stopped) return;
      clearTimeout(timer);
      const delay = Math.min(10000, 1000 * Math.pow(2, retry++));
      timer = setTimeout(open, delay);
    }
    watchdog = setInterval(() => {
      if (ws && ws.readyState === 1) {
        try { ws.send('{"type":"ping"}'); } catch {}
        if (Date.now() - lastMsg > 35000) { try { ws.close(); } catch {} }
      }
    }, 10000);
    // Po prebudení zariadenia / návrate siete sa pripojíme hneď.
    window.addEventListener('online', () => { if (!ws) { retry = 0; clearTimeout(timer); open(); } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !ws) { retry = 0; clearTimeout(timer); open(); } });
    open();
    return {
      stop() { stopped = true; clearInterval(watchdog); clearTimeout(timer); try { ws && ws.close(); } catch {} },
      reconnectNow() { retry = 0; clearTimeout(timer); if (!ws) open(); },
    };
  }

  /** UUID v4 (aj v starších WebView bez crypto.randomUUID). */
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  const TZ = 'Europe/Bratislava';
  const fmtTime = (iso) => iso ? new Intl.DateTimeFormat('sk-SK', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '';
  const fmtDateTime = (iso) => iso ? new Intl.DateTimeFormat('sk-SK', { timeZone: TZ, day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '';
  const fmtDay = (day) => { const [y, m, d] = String(day).split('-'); return `${+d}. ${+m}. ${y}`; };
  /** Dĺžka čakania v minútach ako text („5 min“, „1 h 20 min“). */
  function fmtWait(fromIso, toMs) {
    const min = Math.max(0, Math.floor(((toMs || Date.now()) - new Date(fromIso).getTime()) / 60000));
    if (min < 60) return min + ' min';
    return Math.floor(min / 60) + ' h ' + (min % 60) + ' min';
  }
  const STATUS_TEXT = { waiting: 'Čaká', called: 'Vyvolaný', done: 'Vybavený', absent: 'Neprítomný' };
  const PRINT_TEXT = { ok: 'Vytlačený', unverified: 'Tlač neoverená', failed: 'Tlač zlyhala', disabled: 'Tlač vypnutá', pending: 'Tlačí sa' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  window.AdNa = { api, ApiError, connect, uuid, fmtTime, fmtDateTime, fmtDay, fmtWait, STATUS_TEXT, PRINT_TEXT, esc };
})();
