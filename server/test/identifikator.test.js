'use strict';
// 2026-11-17 (Pali): sestra dopíše k číslu identifikátor a typ pacienta. Vidí ich všetok personál
// (sestry, lekári, správca) – nikdy obrazovka v čakárni, tablet ani verejné API.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const h = require('./helpers');
h.freshDataDir();
const clock = require('../src/clock');

const MENO = 'Jožko Testovací 1955';
let s, admin, sestra, lekar, kiosk, room;
before(async () => {
  s = await h.start({ kioskRateLimit: 100000 });
  admin = await h.setupAndLogin(s); kiosk = h.client(s.base);
  room = (await admin.get('/api/staff/state')).data.rooms[0];
  await admin.post('/api/admin/users', { username: 'ambulancia1', password: 'Heslo-sestry-01', roomId: room.id });
  await admin.post('/api/admin/users', { username: 'kudela', password: 'Heslo-lekara-01', roomId: room.id, doctorName: 'MUDr. Ján Kúdela' });
  sestra = h.client(s.base); lekar = h.client(s.base);
  assert.equal((await sestra.post('/api/auth/login', { username: 'ambulancia1', password: 'Heslo-sestry-01' })).status, 200);
  assert.equal((await lekar.post('/api/auth/login', { username: 'kudela', password: 'Heslo-lekara-01' })).status, 200);
});
after(() => { clock.setOffset(0); return s.close(); });

function open(channel, cookie) {
  const ws = new WebSocket(s.base.replace('http', 'ws') + '/ws?channel=' + channel, { headers: cookie ? { Cookie: cookie } : {} });
  const raw = [];
  ws.on('message', (m) => raw.push(String(m)));
  const waitFor = async (pred, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const m = raw.map((x) => JSON.parse(x)).find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error('správa neprišla');
  };
  return { ws, raw, waitFor };
}
const noName = (obj, where) => {
  const j = typeof obj === 'string' ? obj : JSON.stringify(obj);
  assert.ok(!j.includes('Testovací'), `identifikátor nesmie byť v: ${where}`);
  assert.ok(!/varixy|CLaCS|AVF|angio|hemoroidy/.test(j), `typ pacienta nesmie byť v: ${where}`);
};

test('sestra zadá identifikátor pri pridaní pacienta a vidí ho v zozname', async () => {
  const r = await sestra.post('/api/staff/cards', { cardNo: 'ID1', plannedTime: '23:00', roomId: room.id, staffNote: `  ${MENO}  `, patientType: 'Kontrola varixy' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.ticket.staffNote, MENO);
  assert.equal(r.data.ticket.patientType, 'Kontrola varixy');
  const st = (await sestra.get('/api/staff/state')).data;
  assert.equal(st.patientTypes[0], 'Vstupné vyšetrenie varixy', 'najčastejší typ je prvý');
  assert.equal(st.patientTypes[7], 'AVF', 'AVF je za pôvodnými typmi');
  for (const x of ['Vstup', 'Vstup hemoroidy', 'Kontrola hemoroidy', 'Pooperačná kontrola hemoroidy']) assert.ok(st.patientTypes.includes(x), `nový výkon v ponuke: ${x}`);
  const r2 = await sestra.post('/api/staff/cards', { cardNo: 'ID3', plannedTime: '23:20', roomId: room.id, patientType: 'Vstup hemoroidy' });
  assert.equal(r2.data.ticket.patientType, 'Vstup hemoroidy', 'nový výkon sa dá uložiť');
  const t = st.tickets.find((x) => x.code === 'ID1');
  assert.equal(t.staffNote, MENO); assert.equal(t.patientType, 'Kontrola varixy');
  const a = (await admin.get('/api/staff/state')).data.tickets.find((x) => x.code === 'ID1');
  assert.equal(a.staffNote, MENO, 'správca (admin) ho vidí');
});

test('lekár identifikátor a typ vidí; obrazovka, tablet ani verejné API nie', async () => {
  noName((await kiosk.get('/api/display/state')).data, '/api/display/state');
  noName((await kiosk.get('/api/public/config')).data, '/api/public/config');
  const k = await kiosk.post('/api/kiosk/tickets', { requestId: crypto.randomUUID() });
  noName(k.data, 'odpoveď tabletu');
  assert.equal((await kiosk.get('/api/staff/state')).status, 401);
  const ls = (await lekar.get('/api/staff/state')).data;
  const lt = ls.tickets.find((x) => x.code === 'ID1');
  assert.equal(lt.staffNote, MENO, 'lekár identifikátor vidí'); assert.equal(lt.patientType, 'Kontrola varixy');
  assert.equal((await lekar.get('/api/staff/history?day=' + ls.day)).data.tickets.find((x) => x.code === 'ID1').staffNote, MENO);
  const sh = (await sestra.get('/api/staff/history?day=' + ls.day)).data;
  assert.equal(sh.tickets.find((x) => x.code === 'ID1').staffNote, MENO, 'sestra ho vidí aj v histórii dneška');
  // lekár vyvolá pacienta – odpoveď ani správa „call“ ho neobsahuje
  const d = open('display');
  await d.waitFor((m) => m.type === 'display.state');
  const id1 = ls.tickets.find((x) => x.code === 'ID1').id;
  const c = await lekar.post(`/api/staff/tickets/${id1}/call`, { roomId: room.id });
  assert.equal(c.status, 200); noName(c.data.call, 'správa o vyvolaní pre TV');
  await d.waitFor((m) => m.type === 'call');
  d.raw.forEach((m) => noName(m, 'WebSocket obrazovky'));
  d.ws.close();
  assert.equal((await lekar.post(`/api/staff/tickets/${id1}/note`, { staffNote: 'x' })).status, 403, 'lekár identifikátor nemení');
});

test('WebSocket: sestra aj lekár dostanú identifikátor, obrazovka nie', async () => {
  const d = open('display'); const se = open('staff', sestra.cookie); const le = open('staff', lekar.cookie);
  await Promise.all([d.waitFor((m) => m.type === 'display.state'), se.waitFor((m) => m.type === 'staff.state'), le.waitFor((m) => m.type === 'staff.state')]);
  const r = await sestra.post('/api/staff/cards', { cardNo: 'ID2', plannedTime: '23:10', roomId: room.id, staffNote: 'Druhý Testovací', patientType: 'AVF' });
  await se.waitFor((m) => m.type === 'staff.state' && m.state.tickets.some((t) => t.code === 'ID2' && t.staffNote === 'Druhý Testovací'));
  await le.waitFor((m) => m.type === 'staff.state' && m.state.tickets.some((t) => t.code === 'ID2' && t.staffNote === 'Druhý Testovací' && t.patientType === 'AVF'));
  await d.waitFor((m) => m.type === 'display.state' && m.state.queue.some((q) => q.code === 'ID2'));
  d.raw.forEach((m) => noName(m, 'WebSocket obrazovky'));
  // zmena a vymazanie identifikátora
  const u = await sestra.post(`/api/staff/tickets/${r.data.ticket.id}/note`, { staffNote: 'Iný Testovací' });
  assert.equal(u.status, 200); assert.equal(u.data.ticket.staffNote, 'Iný Testovací');
  assert.equal(u.data.ticket.patientType, 'AVF', 'typ ostal');
  const e = await sestra.post(`/api/staff/tickets/${r.data.ticket.id}/edit`, { staffNote: '', patientType: 'Kontrola angio' });
  assert.equal(e.status, 200); assert.equal(e.data.ticket.staffNote, null); assert.equal(e.data.ticket.patientType, 'Kontrola angio');
  assert.equal((await sestra.post(`/api/staff/tickets/${r.data.ticket.id}/note`, { patientType: 'Niečo iné' })).status, 400, 'len typ z ponuky');
  [d, se, le].forEach((x) => x.ws.close());
});

test('príliš dlhý identifikátor sa odmietne', async () => {
  const r = await sestra.post('/api/staff/cards', { cardNo: 'ID3', plannedTime: '23:20', staffNote: 'x'.repeat(61) });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /Identifikátor/);
});

test('po zmene dňa sa identifikátory zo včerajška vymažú, čísla ostanú', async () => {
  const before = s.store.db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;
  clock.setOffset(24 * 3600_000);
  s.store.tick();
  const n = s.store.db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE staff_note IS NOT NULL').get().n;
  assert.equal(n, 0);
  assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, before, 'záznamy čísel sa nemažú');
});
