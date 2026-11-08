'use strict';
// Sieťová tlač na ESC/POS tlačiareň (TCP, typicky port 9100, „RAW“/„JetDirect“).
const net = require('node:net');
const { buildTicket, STATUS_QUERY, parseStatus } = require('./escpos');
const log = require('./log');

let chain = Promise.resolve(); // tlač po jednom – tlačiareň je jedna
let last = { status: null, message: null, checkedAt: null };

function serialize(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

const MSG = {
  disabled: 'Tlač lístkov je vypnutá v nastaveniach.',
  noHost: 'Tlačiareň nie je nastavená (chýba IP adresa).',
  unreachable: 'Tlačiareň je nedostupná. Skontrolujte, či je zapnutá a pripojená k sieti.',
  paperOut: 'V tlačiarni chýba papier.',
  cover: 'Tlačiareň má otvorený kryt.',
  error: 'Tlačiareň hlási chybu.',
  ok: 'Lístok bol vytlačený (tlačiareň nehlási chybu).',
  unverified: 'Lístok bol odoslaný na tlačiareň, ale tlač nie je možné overiť. Skontrolujte tlačiareň.',
  interrupted: 'Spojenie s tlačiarňou sa počas tlače prerušilo.',
};

/** Otvorí TCP spojenie a vráti pomocné funkcie na zápis/čítanie s časovým limitom. */
function connect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    const buf = [];
    let waiter = null;
    let closed = false;
    const t = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, timeoutMs);
    sock.on('connect', () => {
      clearTimeout(t);
      resolve({
        write: (data) => new Promise((res, rej) => sock.write(data, (e) => (e ? rej(e) : res()))),
        /** Prečíta n bajtov alebo vráti null pri vypršaní času. */
        read: (n, ms) => new Promise((res) => {
          const check = () => {
            const total = Buffer.concat(buf);
            if (total.length >= n) { buf.length = 0; if (total.length > n) buf.push(total.subarray(n)); waiter = null; clearTimeout(tt); res(total.subarray(0, n)); return true; }
            return false;
          };
          const tt = setTimeout(() => { waiter = null; res(null); }, ms);
          if (!check()) waiter = check;
          if (closed) { clearTimeout(tt); res(null); }
        }),
        isClosed: () => closed,
        end: () => new Promise((res) => { if (closed) return res(); sock.end(() => res()); setTimeout(() => { sock.destroy(); res(); }, 1000); }),
      });
    });
    sock.on('data', (d) => { buf.push(d); if (waiter) waiter(); });
    sock.on('error', (e) => { closed = true; clearTimeout(t); reject(e); });
    sock.on('close', () => { closed = true; if (waiter) waiter(); });
  });
}

async function queryStatus(conn, cfg) {
  if (!cfg.statusCheck) return null;
  await conn.write(STATUS_QUERY);
  const r = await conn.read(2, cfg.statusTimeoutMs);
  if (!r) return null;
  return parseStatus(r[0], r[1]);
}

function problemMessage(st) {
  if (st.paperOut) return MSG.paperOut;
  if (st.cover) return MSG.cover;
  if (st.error) return MSG.error;
  return null;
}

/**
 * Vytlačí lístok. Nikdy nevyhodí výnimku – vždy vráti {status, message}.
 * @param {object} cfg nastavenia tlačiarne
 * @param {{code:string, createdAt:string, clinicName:string, instruction:string, reprint?:boolean}} ticket
 */
function printTicket(cfg, ticket) {
  return serialize(async () => {
    const result = await doPrint(cfg, ticket);
    last = { status: result.status, message: result.message, checkedAt: new Date().toISOString() };
    if (result.status === 'failed') log.warn('Tlač zlyhala', { code: ticket.code, reason: result.reason });
    return result;
  });
}

async function doPrint(cfg, ticket) {
  if (!cfg.enabled) return { status: 'disabled', message: MSG.disabled };
  if (!cfg.host) return { status: 'failed', message: MSG.noHost, reason: 'no-host' };
  let conn;
  try {
    conn = await connect(cfg.host, cfg.port, cfg.connectTimeoutMs);
  } catch (e) {
    return { status: 'failed', message: MSG.unreachable, reason: e.code || e.message };
  }
  try {
    const before = await queryStatus(conn, cfg);
    if (before) {
      const p = problemMessage(before);
      if (p) return { status: 'failed', message: p, reason: 'status-before' };
    }
    const data = buildTicket({
      code: ticket.code, clinicName: ticket.clinicName, createdAt: new Date(ticket.createdAt),
      instruction: ticket.instruction, footer: cfg.footer, encoding: cfg.encoding,
      codePage: cfg.codePage, cut: cfg.cut, reprint: ticket.reprint,
    });
    await conn.write(data);
    if (!before) return { status: 'unverified', message: MSG.unverified };
    const after = await queryStatus(conn, cfg);
    if (!after) return { status: 'unverified', message: MSG.unverified };
    const p = problemMessage(after);
    if (p) return { status: 'unverified', message: p + ' Lístok sa nemusel vytlačiť celý.' };
    return { status: 'ok', message: MSG.ok, paperNear: after.paperNear };
  } catch (e) {
    return { status: 'unverified', message: MSG.interrupted + ' ' + MSG.unverified, reason: e.code || e.message };
  } finally {
    try { await conn.end(); } catch {}
  }
}

/** Zistí stav tlačiarne bez tlače. */
function checkPrinter(cfg) {
  return serialize(async () => {
    const r = await doCheck(cfg);
    last = { status: r.status, message: r.message, checkedAt: new Date().toISOString() };
    return r;
  });
}

async function doCheck(cfg) {
  {
    if (!cfg.enabled) return { status: 'disabled', message: MSG.disabled };
    if (!cfg.host) return { status: 'failed', message: MSG.noHost };
    let conn;
    try { conn = await connect(cfg.host, cfg.port, cfg.connectTimeoutMs); }
    catch { return { status: 'failed', message: MSG.unreachable }; }
    try {
      const st = await queryStatus({ ...conn }, { ...cfg, statusCheck: true });
      if (!st) return { status: 'unverified', message: 'Tlačiareň je dostupná v sieti, ale neodpovedá na stavový dotaz.' };
      const p = problemMessage(st);
      if (p) return { status: 'failed', message: p };
      return { status: 'ok', message: st.paperNear ? 'Tlačiareň je pripravená, papier sa míňa.' : 'Tlačiareň je pripravená.' };
    } finally { try { await conn.end(); } catch {} }
  }
}

function lastStatus() { return last; }

module.exports = { printTicket, checkPrinter, lastStatus, MSG };
