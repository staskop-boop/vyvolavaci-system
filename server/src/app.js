'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const config = require('./config');
const db = require('./db');
const { Store, AppError } = require('./store');
const { Auth } = require('./auth');
const clock = require('./clock');
const log = require('./log');
const { News } = require('./news');
const { Weather } = require('./weather');

const COOKIE = 'adna_session';

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Jednoduchý rýchlostný limit (okno 60 s) podľa IP. */
function rateLimiter(max) {
  const hits = new Map();
  setInterval(() => hits.clear(), 60_000).unref();
  return (req, res, next) => {
    const k = req.ip;
    const n = (hits.get(k) || 0) + 1;
    hits.set(k, n);
    if (n > max) return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Príliš veľa požiadaviek. Skúste to o chvíľu.' } });
    next();
  };
}

function createServer(opts = {}) {
  const database = opts.db || db.open(opts.dbFile || config.dbFile);
  const store = new Store(database);
  const auth = new Auth(database);
  const news = new News(() => store.getSettings(), { fetch: opts.newsFetch });
  if (opts.news !== false) news.start();
  const weather = new Weather(() => store.getSettings(), { fetch: opts.weatherFetch });
  if (opts.weather !== false && opts.news !== false) weather.start();
  const setupCode = auth.ensureSetupCode();
  if (setupCode && !opts.silentSetup) {
    log.info('Nie je nastavené heslo personálu. Otvorte /sestra/ a použite inštalačný kód', { file: path.join(config.dataDir, 'SETUP-KOD.txt') });
    console.log(`\n  ==== INŠTALAČNÝ KÓD: ${setupCode} ====\n  (uložený aj v ${path.join(config.dataDir, 'SETUP-KOD.txt')})\n`);
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);
  const userOf = (req) => auth.check(parseCookies(req.headers.cookie)[COOKIE]);
  const requireStaff = (req, res, next) => {
    const u = userOf(req);
    if (!u) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Prihlásenie vypršalo. Prihláste sa znova.' } });
    // Ochrana CSRF: zapisujúce volania len s JSON telom (prehliadač ho cudzej stránke bez CORS nepovolí).
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Neplatná požiadavka.' } });
    req.user = u;
    next();
  };
  const requireAdmin = (req, res, next) => requireStaff(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Na túto akciu nemáte oprávnenie.' } });
    next();
  });
  const id = (req) => {
    const n = Number(req.params.id);
    if (!Number.isInteger(n) || n <= 0) throw new AppError(400, 'BAD_REQUEST', 'Neplatné číslo záznamu.');
    return n;
  };

  // ---------- verejné ----------
  app.get('/api/health', (req, res) => res.json({ ok: true, time: clock.nowIso(), day: clock.today() }));
  app.get('/api/public/config', (req, res) => res.json(store.publicConfig()));
  app.get('/api/display/state', (req, res) => res.json(store.displayState()));
  app.get('/api/display/news', (req, res) => res.json(news.publicState()));
  app.get('/api/display/weather', (req, res) => res.json(weather.publicState()));
  app.post('/api/kiosk/tickets', rateLimiter(opts.kioskRateLimit || 60), wrap(async (req, res) => {
    const r = await store.register(req.body?.requestId, req.body?.deviceId);
    res.status(r.duplicate ? 200 : 201).json(r);
  }));

  // ---------- prihlásenie ----------
  app.get('/api/setup/status', (req, res) => res.json({ setupRequired: auth.setupRequired() }));
  app.post('/api/setup', rateLimiter(10), (req, res) => {
    const r = auth.completeSetup(req.body?.setupCode, req.body?.password);
    if (r.error) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: r.error } });
    res.json({ ok: true });
  });
  // Secure: vždy pri ADNA_SECURE_COOKIE=1, inak automaticky pri HTTPS (napr. cez Cloudflare Tunnel na tom istom PC),
  // takže na lokálnom serveri funguje prihlásenie cez https://vyvolavaci.adna.sk aj cez http:// v LAN.
  const setCookie = (req, res, token, maxAge) => {
    const secure = config.secureCookie || req.secure;
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  };
  app.post('/api/auth/login', (req, res) => {
    if (auth.setupRequired()) return res.status(409).json({ error: { code: 'SETUP_REQUIRED', message: 'Najprv dokončite prvotné nastavenie hesla.' } });
    const r = auth.login(req.body?.username || 'personal', req.body?.password, req.ip, req.body?.deviceLabel);
    if (r.error) return res.status(r.locked ? 429 : 401).json({ error: { code: r.locked ? 'RATE_LIMITED' : 'UNAUTHORIZED', message: r.error } });
    setCookie(req, res, r.token, config.sessionHours * 3600 * 14); // cookie žije dlhšie, platnosť stráži server
    res.json({ user: r.user });
  });
  app.post('/api/auth/logout', (req, res) => {
    auth.logout(parseCookies(req.headers.cookie)[COOKIE]);
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  });
  app.get('/api/auth/me', (req, res) => {
    const u = userOf(req);
    if (!u) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Nie ste prihlásený.' } });
    res.json({ user: u });
  });

  // ---------- personál ----------
  app.get('/api/staff/state', requireStaff, (req, res) => res.json(store.staffState()));
  app.post('/api/staff/tickets/:id/call', requireStaff, (req, res) => res.json(store.call(id(req), req.body?.roomId, req.user.id, req.body?.note)));
  app.post('/api/staff/call-next', requireStaff, (req, res) => res.json(store.callNext(req.body?.roomId, req.user.id)));
  app.post('/api/staff/tickets/:id/recall', requireStaff, (req, res) => res.json(store.recall(id(req), req.body?.roomId, req.user.id)));
  app.post('/api/staff/tickets/:id/done', requireStaff, (req, res) => res.json(store.done(id(req), req.user.id)));
  app.post('/api/staff/tickets/:id/absent', requireStaff, (req, res) => res.json(store.absent(id(req), req.user.id)));
  app.post('/api/staff/tickets/:id/requeue', requireStaff, (req, res) => res.json(store.requeue(id(req), req.user.id)));
  app.post('/api/staff/tickets/:id/reprint', requireStaff, wrap(async (req, res) => res.json(await store.reprint(id(req), req.user.id))));
  app.post('/api/staff/cards', requireStaff, (req, res) => res.status(201).json(store.registerCard(req.body?.cardNo, req.body?.plannedTime, req.user.id,
    req.body && 'roomId' in req.body ? req.body.roomId : req.user.roomId)));
  app.post('/api/staff/announcement', requireStaff, (req, res) => res.json(store.setAnnouncement(req.body?.text, req.user)));
  app.post('/api/staff/rooms/:id/doctor', requireStaff, (req, res) => res.json(store.setDoctor(id(req), req.body?.name, req.user.id)));
  app.post('/api/staff/rooms/:id/delay', requireStaff, (req, res) => res.json(store.setRoomDelay(id(req), req.body?.minutes ?? null, req.body?.text)));
  app.post('/api/staff/tickets/:id/planned', requireStaff, (req, res) => res.json(store.setPlanned(id(req), req.body?.plannedTime, req.user.id)));
  app.get('/api/staff/days', requireStaff, (req, res) => res.json({ days: store.days() }));
  app.get('/api/staff/history', requireStaff, (req, res) => res.json(store.history(req.query.day)));

  // ---------- administrácia ----------
  app.get('/api/admin/settings', requireAdmin, (req, res) => res.json(store.getSettings()));
  app.put('/api/admin/settings', requireAdmin, (req, res) => res.json(store.updateSettings(req.body)));
  app.get('/api/admin/news', requireAdmin, (req, res) => res.json({ feeds: news.status(), updatedAt: news.updatedAt, items: news.items.length }));
  app.post('/api/admin/news/refresh', requireAdmin, wrap(async (req, res) => { await news.refresh(); res.json({ feeds: news.status(), updatedAt: news.updatedAt, items: news.items.length }); }));
  const userResult = (res, r, okStatus = 200) => {
    if (r.error) return res.status(r.status || 400).json({ error: { code: r.status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', message: r.error } });
    store.changed('users');
    res.status(okStatus).json(r);
  };
  app.get('/api/admin/users', requireAdmin, (req, res) => res.json({ users: auth.listUsers() }));
  app.post('/api/admin/users', requireAdmin, (req, res) => userResult(res, auth.createUser(req.body || {}), 201));
  app.put('/api/admin/users/:id', requireAdmin, (req, res) => userResult(res, auth.updateUser(id(req), req.body || {}, req.user.id)));
  app.get('/api/admin/rooms', requireAdmin, (req, res) => res.json({ rooms: store.listRooms() }));
  app.post('/api/admin/rooms', requireAdmin, (req, res) => res.status(201).json(store.createRoom(req.body)));
  app.put('/api/admin/rooms/:id', requireAdmin, (req, res) => res.json(store.updateRoom(id(req), req.body)));
  app.delete('/api/admin/rooms/:id', requireAdmin, (req, res) => res.json(store.deleteRoom(id(req))));
  app.post('/api/admin/password', requireAdmin, (req, res) => {
    const r = auth.changePassword(req.user.id, req.body?.currentPassword, req.body?.newPassword, parseCookies(req.headers.cookie)[COOKIE]);
    if (r.error) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: r.error } });
    res.json({ ok: true });
  });
  app.post('/api/admin/close-day', requireAdmin, (req, res) => {
    if (req.body?.confirm !== 'UKONČIŤ') throw new AppError(400, 'BAD_REQUEST', 'Potvrďte ukončenie dňa napísaním slova UKONČIŤ.');
    res.json(store.closeDay(req.user.id));
  });
  app.post('/api/admin/purge', requireAdmin, (req, res) => {
    if (req.body?.confirm !== 'VYMAZAŤ') throw new AppError(400, 'BAD_REQUEST', 'Potvrďte vymazanie napísaním slova VYMAZAŤ.');
    if (!auth.verifyUserPassword(req.user.id, req.body?.password)) throw new AppError(400, 'BAD_REQUEST', 'Heslo nie je správne.');
    res.json(store.purge(req.body?.scope));
  });
  app.post('/api/admin/printer/test', requireAdmin, wrap(async (req, res) => {
    const s = store.getSettings();
    const printer = require('./printer');
    if (req.body?.print) {
      const r = await printer.printTicket(s.printer, { code: 'TEST', createdAt: clock.nowIso(), clinicName: s.clinicName, instruction: 'Skúšobná tlač – nie je to poradové číslo.' });
      return res.json(r);
    }
    res.json(await printer.checkPrinter(s.printer));
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Neznáma adresa API.' } }));

  // ---------- statické aplikácie ----------
  const staticOpts = { index: 'index.html', maxAge: 0, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') };
  const mount = (url, dir) => { if (fs.existsSync(dir)) app.use(url, express.static(dir, staticOpts)); };
  mount('/shared', config.sharedDir);
  mount('/sestra', path.join(config.appsDir, 'sestra', 'web'));
  mount('/tablet', path.join(config.appsDir, 'tablet', 'web'));
  mount('/obrazovka', path.join(config.appsDir, 'tv', 'web'));
  app.get('/', (req, res) => res.redirect('/shared/index.html'));

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof AppError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Neplatný formát požiadavky.' } });
    log.error('Neočakávaná chyba', { path: req.path, err: String(err && err.stack || err).slice(0, 800) });
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Nastala chyba servera. Skúste to znova.' } });
  });

  // ---------- WebSocket ----------
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const channel = url.searchParams.get('channel') === 'staff' ? 'staff' : 'display';
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (channel === 'staff' && !auth.check(token)) { ws.close(4401, 'unauthorized'); return; }
      ws.channel = channel; ws.token = token; ws.alive = true;
      clients.add(ws);
      ws.on('pong', () => { ws.alive = true; });
      ws.on('message', (m) => {
        ws.alive = true;
        try { if (JSON.parse(String(m)).type === 'ping') ws.send('{"type":"pong"}'); } catch {}
      });
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
      sendState(ws);
    });
  });

  function send(ws, obj) { if (ws.readyState === 1) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
  function sendState(ws) {
    if (ws.channel === 'staff') send(ws, { type: 'staff.state', rev: store.rev, state: store.staffState() });
    else send(ws, { type: 'display.state', rev: store.rev, state: store.displayState() });
  }

  // Zmeny zlučujeme (25 ms), aby sa pri dávke zmien neposielal stav viackrát.
  let pending = null;
  store.on('change', () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      const disp = JSON.stringify({ type: 'display.state', rev: store.rev, state: store.displayState() });
      let staff = null;
      for (const ws of clients) {
        if (ws.channel === 'staff') {
          if (!auth.check(ws.token)) { ws.close(4401, 'unauthorized'); continue; }
          staff = staff || JSON.stringify({ type: 'staff.state', rev: store.rev, state: store.staffState() });
          send(ws, staff);
        } else send(ws, disp);
      }
    }, 25);
  });
  store.on('change', (kind) => { if (kind === 'settings' && opts.news !== false) { news.refresh().catch(() => {}); weather.refresh().catch(() => {}); } });
  store.on('call', (call) => {
    const msg = JSON.stringify({ type: 'call', call });
    for (const ws of clients) send(ws, msg);
  });

  const timers = [
    setInterval(() => {
      for (const ws of clients) {
        if (!ws.alive) { ws.terminate(); clients.delete(ws); continue; }
        ws.alive = false;
        try { ws.ping(); } catch {}
        send(ws, '{"type":"ping"}');
      }
    }, opts.pingMs || 15_000),
    setInterval(() => store.tick(), 20_000),
    setInterval(() => auth.purgeExpired(), 3600_000),
  ];
  timers.forEach((t) => t.unref());

  function close() {
    return new Promise((resolve) => {
      timers.forEach(clearInterval);
      news.stop(); weather.stop();
      clearTimeout(pending); pending = null; store.removeAllListeners();
      for (const ws of clients) ws.terminate();
      wss.close();
      server.close(() => { try { database.close(); } catch {} resolve(); });
      server.closeAllConnections?.();
    });
  }

  return { app, server, store, auth, news, weather, db: database, close };
}

module.exports = { createServer };
