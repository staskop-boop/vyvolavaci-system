'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const clock = require('./clock');
const log = require('./log');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_PASSWORD = 10;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const got = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(expected, got);
  } catch { return false; }
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `Heslo musí mať aspoň ${MIN_PASSWORD} znakov.`;
  if (pw.length > 200) return 'Heslo je príliš dlhé.';
  return null;
}

/** Meno konta tak, ako ho ľudia píšu: bez diakritiky a veľkých písmen („Czetöová“ → „czetoova“). */
const plainName = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
/** Prihlasovacie meno lekára z celého mena (priezvisko bez titulov a diakritiky) – rovnako ako pri zakladaní kont. */
const surnameLogin = (full) => {
  const parts = String(full).split(',')[0].replace(/\b(MUDr|MVDr|Mgr|Bc|Ing|doc|prof|PhD|MHA|MPH)\.?/gi, ' ').trim().split(/\s+/);
  return plainName(parts[parts.length - 1] || '').replace(/[^a-z0-9._-]/g, '');
};

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

class Auth {
  constructor(db) { this.db = db; this.failures = new Map(); }

  setupRequired() {
    return !this.db.prepare('SELECT 1 FROM users WHERE active = 1 LIMIT 1').get();
  }

  /** Jednorazový inštalačný kód – vytvorí sa iba ak ešte neexistuje žiadne konto. */
  ensureSetupCode() {
    if (!this.setupRequired()) { this.setupCode = null; return null; }
    const file = path.join(config.dataDir, 'SETUP-KOD.txt');
    let code = null;
    try { code = fs.readFileSync(file, 'utf8').match(/KOD:\s*(\S+)/)?.[1] || null; } catch {}
    if (!code) {
      code = crypto.randomBytes(5).toString('hex').toUpperCase();
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(file, `Jednorazovy instalacny kod AdNa\nKOD: ${code}\n\nPouzite ho na /sestra/ pri prvotnom nastaveni hesla. Po nastaveni sa subor vymaze.\n`, { mode: 0o600 });
    }
    this.setupCode = code;
    return code;
  }

  completeSetup(setupCode, password) {
    if (!this.setupRequired()) return { error: 'Prvotné nastavenie už bolo dokončené.' };
    if (!this.setupCode || String(setupCode || '').trim().toUpperCase() !== this.setupCode) return { error: 'Nesprávny inštalačný kód.' };
    const err = validatePassword(password);
    if (err) return { error: err };
    this.createOrResetUser('admin', password, 'admin');
    try { fs.rmSync(path.join(config.dataDir, 'SETUP-KOD.txt')); } catch {}
    this.setupCode = null;
    log.info('Prvotné nastavenie hesla dokončené');
    return { ok: true };
  }

  createOrResetUser(username, password, role = 'admin') {
    const h = hashPassword(password);
    const ex = this.db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (ex) {
      this.db.prepare('UPDATE users SET password_hash = ?, active = 1, role = ? WHERE id = ?').run(h, role, ex.id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(ex.id);
      return ex.id;
    }
    return Number(this.db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)')
      .run(username, h, role, clock.nowIso()).lastInsertRowid);
  }

  /**
   * Obnova hesla na diaľku (obnova.js): nastaví heslo konta (správcu vytvorí, ak chýba), ale NEzruší doterajšie
   * prihlásenia – sestry v ambulancii pri tom ostanú prihlásené (2026-11-27).
   */
  setPasswordKeepSessions(username, password) {
    const name = plainName(username);
    if (!/^[a-z0-9._-]{2,40}$/.test(name)) return { error: 'Neplatné meno konta.' };
    const err = validatePassword(password);
    if (err) return { error: err };
    const ex = this.db.prepare('SELECT id, role FROM users WHERE username = ?').get(name);
    if (ex) this.db.prepare('UPDATE users SET password_hash = ?, active = 1 WHERE id = ?').run(hashPassword(password), ex.id);
    else if (name === 'admin') this.db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)').run(name, hashPassword(password), 'admin', clock.nowIso());
    else return { error: `Konto „${name}“ neexistuje.` };
    for (const k of [...this.failures.keys()]) if (k.endsWith(':' + name)) this.failures.delete(k);   // zrušiť dočasnú blokáciu po zlých pokusoch
    return { username: name };
  }

  /**
   * Brzda proti hádaniu hesla: po 5 chybách na jedno konto z jednej IP 60 s pauza – len pre to konto.
   * 2026-11-17: predtým sa blokovala celá IP, a keďže celá ambulancia ide von cez jednu adresu (Cloudflare),
   * preklepy jedného človeka zablokovali prihlásenie všetkým. Celkovo z jednej IP najviac 20 chýb za minútu.
   */
  isLocked(ip, name) {
    const now = Date.now();
    const left = (f) => (f && f.until > now ? Math.ceil((f.until - now) / 1000) : 0);
    return Math.max(left(this.failures.get('u:' + ip + ':' + name)), left(this.failures.get('ip:' + ip)));
  }
  noteFailure(ip, name) {
    for (const [k, max] of [['u:' + ip + ':' + name, 5], ['ip:' + ip, 20]]) {
      const f = this.failures.get(k) || { count: 0, until: 0 };
      f.count += 1;
      if (f.count >= max) { f.until = Date.now() + 60_000; f.count = 0; log.warn('Opakované neúspešné prihlásenie', { ip, konto: k.startsWith('u:') ? name : '*' }); }
      this.failures.set(k, f);
    }
  }

  login(username, password, ip, label) {
    const name = plainName(username);
    const wait = this.isLocked(ip, name);
    if (wait) return { error: `Príliš veľa neúspešných pokusov pre konto „${name}“. Skúste znova o ${wait} s.`, locked: true };
    const find = (n) => this.db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(n);
    // konto správcu sa do 2026-11-16 volalo „personal“ – staré meno ešte funguje, ak také konto neexistuje;
    // lekár sa môže prihlásiť aj celým menom („MUDr. Adela Czetöová“ → konto czetoova)
    const u = find(name) || (name === 'personal' ? find('admin') : null) || (/\s/.test(name) ? find(surnameLogin(name)) : null);
    // konto lekára založené bez hesla – prihlásiť sa nedá, kým ho správca nenastaví (nepočíta sa ako pokus o uhádnutie)
    if (u && u.password_hash === '!') return { error: `Konto „${u.username}“ ešte nemá nastavené heslo. Nastaví ho správca v Nastaveniach → Kontá.` };
    if (!u || !verifyPassword(password, u.password_hash)) { this.noteFailure(ip, name); return { error: 'Nesprávne meno alebo heslo.' }; }
    this.failures.delete('u:' + ip + ':' + name);
    const token = crypto.randomBytes(32).toString('base64url');
    const now = clock.now();
    const exp = new Date(now.getTime() + config.sessionHours * 3600_000);
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, label) VALUES (?,?,?,?,?,?)')
      .run(sha(token), u.id, now.toISOString(), exp.toISOString(), now.toISOString(), String(label || '').slice(0, 100));
    return { token, user: { id: u.id, username: u.username, role: u.role, roomId: u.room_id ?? null, doctorName: u.doctor_name || null, nurseName: u.nurse_name || null } };
  }

  /** Overí token; posúva platnosť (kĺzavá expirácia). */
  check(token) {
    if (!token) return null;
    const row = this.db.prepare(`SELECT s.token_hash, s.expires_at, s.last_seen_at, u.id, u.username, u.role, u.room_id, u.doctor_name, u.nurse_name FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.active = 1`).get(sha(token));
    if (!row) return null;
    const now = clock.now();
    if (new Date(row.expires_at) < now) { this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash); return null; }
    if (now - new Date(row.last_seen_at) > 60_000) {
      const exp = new Date(now.getTime() + config.sessionHours * 3600_000);
      this.db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(now.toISOString(), exp.toISOString(), row.token_hash);
    }
    return { id: row.id, username: row.username, role: row.role, roomId: row.room_id ?? null, doctorName: row.doctor_name || null, nurseName: (!row.doctor_name && row.nurse_name) || null };
  }

  // ---------- kontá personálu (v2.1: každá ambulancia má vlastné konto) ----------
  listUsers() {
    return this.db.prepare(`SELECT u.id, u.username, u.role, u.active, u.room_id, u.doctor_name, u.nurse_name, u.created_at, u.password_hash = '!' AS no_pw, r.name AS room_name FROM users u
      LEFT JOIN rooms r ON r.id = u.room_id ORDER BY u.id`).all()
      .map((u) => ({ id: u.id, username: u.username, role: u.role, active: !!u.active, roomId: u.room_id ?? null, roomName: u.room_name ?? null,
        doctorName: u.doctor_name || null, nurseName: (!u.doctor_name && u.nurse_name) || null, noPassword: !!u.no_pw, createdAt: u.created_at }));
  }
  /** Meno lekára pre lekárske konto (null = konto sestry/správcu). */
  doctorOk(v) {
    if (v == null || String(v).trim() === '') return { doctorName: null };
    const n = String(v).trim().replace(/\s+/g, ' ');
    if (n.length < 2 || n.length > 60) return { error: 'Meno lekára: 2 – 60 znakov.' };
    return { doctorName: n };
  }
  /** Meno sestry pre osobné konto sestry (null = spoločné konto ambulancie, sestra sa vyberá tlačidlom „Zadať sestru“). */
  nurseOk(v) {
    if (v == null || String(v).trim() === '') return { nurseName: null };
    const n = String(v).trim().replace(/\s+/g, ' ');
    if (n.length < 2 || n.length > 60) return { error: 'Meno sestry: 2 – 60 znakov.' };
    return { nurseName: n };
  }
  validUsername(v) {
    const n = String(v == null ? '' : v).trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(n)) return { error: 'Meno konta: 3 – 30 znakov, malé písmená bez diakritiky, číslice, bodka, pomlčka (napr. ambulancia1).' };
    return { name: n };
  }
  roomOk(roomId) {
    if (roomId == null || roomId === '') return { roomId: null };
    const r = this.db.prepare('SELECT id FROM rooms WHERE id = ? AND active = 1').get(Number(roomId));
    return r ? { roomId: r.id } : { error: 'Vyberte platné pracovisko.' };
  }
  createUser(b) {
    const un = this.validUsername(b && b.username); if (un.error) return un;
    if (this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(un.name)) return { error: `Konto „${un.name}“ už existuje.` };
    const pe = validatePassword(b.password); if (pe) return { error: pe };
    const dn = this.doctorOk(b.doctorName); if (dn.error) return dn;
    const nn = dn.doctorName ? { nurseName: null } : this.nurseOk(b.nurseName); if (nn.error) return nn;
    const role = b.role === 'admin' && !dn.doctorName ? 'admin' : 'staff';
    const rm = this.roomOk(b.roomId); if (rm.error) return rm;
    const id = Number(this.db.prepare('INSERT INTO users (username, password_hash, role, created_at, room_id, doctor_name, nurse_name) VALUES (?,?,?,?,?,?,?)')
      .run(un.name, hashPassword(b.password), role, clock.nowIso(), rm.roomId, dn.doctorName, nn.nurseName).lastInsertRowid);
    log.info('Vytvorené konto', { username: un.name, role });
    return { user: this.listUsers().find((u) => u.id === id) };
  }
  updateUser(id, b, actingUserId) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
    if (!u) return { error: 'Konto neexistuje.', status: 404 };
    // heslo overiť skôr, než sa čokoľvek uloží – inak sa uložila len časť zmien a heslo nie
    if (b.password) { const pe = validatePassword(b.password); if (pe) return { error: pe }; }
    let doctorName = u.doctor_name || null;
    if ('doctorName' in b) { const dn = this.doctorOk(b.doctorName); if (dn.error) return dn; doctorName = dn.doctorName; }
    let nurseName = u.nurse_name || null;
    if ('nurseName' in b) { const nn = this.nurseOk(b.nurseName); if (nn.error) return nn; nurseName = nn.nurseName; }
    if (doctorName) nurseName = null;   // konto je buď lekárske, alebo sestry
    let role = b.role != null ? (b.role === 'admin' ? 'admin' : 'staff') : u.role;
    if (doctorName) role = 'staff';   // lekárske konto nemá nastavenia
    const active = b.active != null ? (b.active ? 1 : 0) : u.active;
    let roomId = u.room_id;
    if ('roomId' in b) { const rm = this.roomOk(b.roomId); if (rm.error) return rm; roomId = rm.roomId; }
    const otherAdmins = this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").get(u.id).n;
    if ((role !== 'admin' || !active) && u.role === 'admin' && otherAdmins === 0) return { error: 'Musí zostať aspoň jedno aktívne konto s oprávnením na nastavenia.' };
    if (!active && u.id === actingUserId) return { error: 'Vlastné konto nemôžete vypnúť.' };
    this.db.prepare('UPDATE users SET role = ?, active = ?, room_id = ?, doctor_name = ?, nurse_name = ? WHERE id = ?').run(role, active, roomId, doctorName, nurseName, u.id);
    if (b.password) {
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), u.id);
    }
    if (b.password || !active || role !== u.role || doctorName !== (u.doctor_name || null) || nurseName !== (u.nurse_name || null)) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    return { user: this.listUsers().find((x) => x.id === u.id) };
  }

  logout(token) { if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token)); }

  changePassword(userId, current, next, keepToken) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!u || !verifyPassword(current, u.password_hash)) return { error: 'Súčasné heslo nie je správne.' };
    const err = validatePassword(next);
    if (err) return { error: err };
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), userId);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, sha(keepToken || ''));
    log.info('Heslo bolo zmenené', { userId });
    return { ok: true };
  }

  verifyUserPassword(userId, pw) {
    const u = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
    return !!u && verifyPassword(pw, u.password_hash);
  }

  purgeExpired() { this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(clock.nowIso()); }
}

module.exports = { Auth, hashPassword, verifyPassword, validatePassword, MIN_PASSWORD };
