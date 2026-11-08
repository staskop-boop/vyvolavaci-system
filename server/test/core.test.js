'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
h.freshDataDir();

let s, staff, kiosk;
before(async () => { s = await h.start({ kioskRateLimit: 100000 }); staff = await h.setupAndLogin(s); kiosk = h.client(s.base); });
after(() => s.close());

const reg = (id) => kiosk.post('/api/kiosk/tickets', { requestId: id || require('node:crypto').randomUUID(), deviceId: 'tablet-1' });

test('čísla sa prideľujú vzostupne bez duplicít (A001, A002, …)', async () => {
  const a = await reg(); const b = await reg(); const c = await reg();
  assert.equal(a.status, 201);
  assert.deepEqual([a.data.ticket.code, b.data.ticket.code, c.data.ticket.code], ['A001', 'A002', 'A003']);
  assert.equal(a.data.print.status, 'disabled');
});

test('opakovaná požiadavka s rovnakým requestId nevytvorí nové číslo', async () => {
  const id = 'req-' + Date.now() + '-same';
  const a = await reg(id); const b = await reg(id);
  assert.equal(a.status, 201); assert.equal(b.status, 200);
  assert.equal(b.data.duplicate, true);
  assert.equal(a.data.ticket.code, b.data.ticket.code);
});

test('100 súbežných registrácií = 100 jedinečných po sebe idúcich čísel', async () => {
  const before = (await staff.get('/api/staff/state')).data.tickets.length;
  const rs = await Promise.all(Array.from({ length: 100 }, () => reg()));
  assert.ok(rs.every((r) => r.status === 201));
  const codes = rs.map((r) => r.data.ticket.code);
  assert.equal(new Set(codes).size, 100);
  const seqs = rs.map((r) => Number(r.data.ticket.code.slice(1))).sort((x, y) => x - y);
  assert.equal(seqs[0], before + 1); assert.equal(seqs[99], before + 100);
});

test('súbežné opakovania tej istej požiadavky (výpadok siete) = jedno číslo', async () => {
  const id = 'req-' + Date.now() + '-burst';
  const rs = await Promise.all(Array.from({ length: 20 }, () => reg(id)));
  assert.equal(new Set(rs.map((r) => r.data.ticket.code)).size, 1);
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
});

test('bez prihlásenia sa k rozhraniu sestry nedostane nikto', async () => {
  const anon = h.client(s.base);
  assert.equal((await anon.get('/api/staff/state')).status, 401);
  assert.equal((await anon.post('/api/staff/call-next', { roomId: 1 })).status, 401);
  assert.equal((await anon.get('/api/admin/settings')).status, 401);
  const bad = await anon.post('/api/auth/login', { username: 'personal', password: 'zle-heslo-xxx' });
  assert.equal(bad.status, 401);
});

test('vyvolanie, zopakovanie, vybavený, neprítomný, vrátenie medzi čakajúcich', async () => {
  const st = (await staff.get('/api/staff/state')).data;
  const room = st.rooms[0];
  const w = st.tickets.find((t) => t.status === 'waiting');
  const c1 = await staff.post('/api/staff/call-next', { roomId: room.id });
  assert.equal(c1.status, 200);
  assert.equal(c1.data.ticket.code, w.code, 'vyvolá sa najdlhšie čakajúci');
  assert.equal(c1.data.call.roomName, room.name);
  let d = (await kiosk.get('/api/display/state')).data;
  assert.equal(d.current.code, w.code);
  const r = await staff.post(`/api/staff/tickets/${w.id}/recall`, {});
  assert.equal(r.data.call.repeat, true); assert.equal(r.data.ticket.callCount, 2);
  assert.equal((await staff.post(`/api/staff/tickets/${w.id}/done`, {})).data.ticket.status, 'done');
  assert.equal((await staff.post(`/api/staff/tickets/${w.id}/recall`, {})).status, 409);
  assert.equal((await staff.post(`/api/staff/tickets/${w.id}/requeue`, {})).data.ticket.status, 'waiting');
  assert.equal((await staff.post(`/api/staff/tickets/${w.id}/absent`, {})).data.ticket.status, 'absent');
});

test('omylom vyvolané číslo: vrátenie ho stiahne z obrazovky', async () => {
  const st = (await staff.get('/api/staff/state')).data;
  const [a, b] = st.tickets.filter((t) => t.status === 'waiting');
  await staff.post(`/api/staff/tickets/${a.id}/call`, { roomId: st.rooms[0].id });
  await staff.post(`/api/staff/tickets/${b.id}/call`, { roomId: st.rooms[1].id, note: 'objednaný pacient' });
  let d = (await kiosk.get('/api/display/state')).data;
  assert.equal(d.current.code, b.code);
  assert.ok(!JSON.stringify(d).includes('objednaný'), 'poznámka personálu sa na obrazovku nedostane');
  await staff.post(`/api/staff/tickets/${b.id}/requeue`, {});
  d = (await kiosk.get('/api/display/state')).data;
  assert.equal(d.current.code, a.code);
  assert.ok(!d.recent.some((x) => x.code === b.code));
});

test('dve sestry súčasne vyvolajú toho istého pacienta → len jedna uspeje', async () => {
  const staff2 = h.client(s.base);
  await staff2.post('/api/auth/login', { username: 'personal', password: 'Testovacie-heslo-1' });
  const st = (await staff.get('/api/staff/state')).data;
  const t = st.tickets.find((x) => x.status === 'waiting');
  const rs = await Promise.all([
    staff.post(`/api/staff/tickets/${t.id}/call`, { roomId: st.rooms[0].id }),
    staff2.post(`/api/staff/tickets/${t.id}/call`, { roomId: st.rooms[1].id }),
  ]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  assert.match(rs.find((r) => r.status === 409).data.error.message, /iná sestra/);
});

test('súbežné „Vyvolať ďalšieho“ z 10 počítačov vyvolá 10 rôznych pacientov', async () => {
  const st = (await staff.get('/api/staff/state')).data;
  const waiting = st.tickets.filter((x) => x.status === 'waiting').length;
  assert.ok(waiting >= 10);
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => staff.post('/api/staff/call-next', { roomId: st.rooms[i % 3].id })));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(new Set(rs.map((r) => r.data.ticket.id)).size, 10);
});

test('nastavenia a ambulancie sa dajú upraviť; neplatné hodnoty sa odmietnu', async () => {
  const r = await staff.put('/api/admin/settings', { ticketDisplaySeconds: 20, recentCount: 3 });
  assert.equal(r.status, 200); assert.equal(r.data.ticketDisplaySeconds, 20);
  assert.equal((await staff.put('/api/admin/settings', { recentCount: 99 })).status, 400);
  const room = await staff.post('/api/admin/rooms', { name: 'Odberová miestnosť' });
  assert.equal(room.status, 201);
  const up = await staff.put(`/api/admin/rooms/${room.data.id}`, { name: 'Odbery' });
  assert.equal(up.data.name, 'Odbery');
  assert.equal((await staff.del(`/api/admin/rooms/${room.data.id}`)).data.deleted, true);
  const cfg = (await kiosk.get('/api/public/config')).data;
  assert.equal(cfg.ticketDisplaySeconds, 20);
});

test('zmena hesla, potvrdenie pri ukončení dňa a vymazaní', async () => {
  assert.equal((await staff.post('/api/admin/password', { currentPassword: 'zle', newPassword: 'Nove-heslo-12345' })).status, 400);
  assert.equal((await staff.post('/api/admin/password', { currentPassword: 'Testovacie-heslo-1', newPassword: 'kratke' })).status, 400);
  assert.equal((await staff.post('/api/admin/password', { currentPassword: 'Testovacie-heslo-1', newPassword: 'Nove-heslo-12345' })).status, 200);
  assert.equal((await staff.get('/api/staff/state')).status, 200, 'aktuálna relácia ostáva');
  assert.equal((await staff.post('/api/admin/close-day', {})).status, 400);
  const cd = await staff.post('/api/admin/close-day', { confirm: 'UKONČIŤ' });
  assert.equal(cd.status, 200);
  const st = (await staff.get('/api/staff/state')).data;
  assert.equal(st.counts.waiting + st.counts.called, 0);
  assert.equal((await kiosk.get('/api/display/state')).data.current, null);
  assert.equal((await staff.post('/api/admin/purge', { confirm: 'VYMAZAŤ', password: 'zle', scope: 'all' })).status, 400);
  const next = await reg();
  assert.ok(Number(next.data.ticket.code.slice(1)) > 100, 'po ukončení dňa sa čísla neopakujú');
});
