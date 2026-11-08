'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const h = require('./helpers');
h.freshDataDir();

let s, staff, kiosk;
before(async () => { s = await h.start({ kioskRateLimit: 100000 }); staff = await h.setupAndLogin(s); kiosk = h.client(s.base); });
after(() => s.close());

function open(channel, cookie) {
  const ws = new WebSocket(s.base.replace('http', 'ws') + '/ws?channel=' + channel, { headers: cookie ? { Cookie: cookie } : {} });
  const msgs = [];
  ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
  const waitFor = async (pred, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const m = msgs.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error('správa neprišla');
  };
  return { ws, msgs, waitFor, closed: new Promise((r) => ws.on('close', (c) => r(c))) };
}

test('kanál staff bez prihlásenia sa odmietne (4401)', async () => {
  const c = open('staff');
  assert.equal(await c.closed, 4401);
});

test('po pripojení príde úplný stav; zmeny a vyvolania prichádzajú v reálnom čase', async () => {
  const d = open('display');
  const st = open('staff', staff.cookie);
  await d.waitFor((m) => m.type === 'display.state');
  await st.waitFor((m) => m.type === 'staff.state');
  const r = await kiosk.post('/api/kiosk/tickets', { requestId: crypto.randomUUID() });
  await st.waitFor((m) => m.type === 'staff.state' && m.state.tickets.some((t) => t.code === r.data.ticket.code));
  const room = (await staff.get('/api/staff/state')).data.rooms[2];
  await staff.post('/api/staff/call-next', { roomId: room.id });
  const call = await d.waitFor((m) => m.type === 'call');
  assert.equal(call.call.code, r.data.ticket.code); assert.equal(call.call.roomName, 'USG pracovisko');
  const ds = await d.waitFor((m) => m.type === 'display.state' && m.state.current);
  assert.equal(ds.state.current.code, r.data.ticket.code);
  assert.ok(!JSON.stringify(d.msgs).includes('"tickets"'), 'verejný kanál nedostáva zoznam personálu');
  d.ws.close(); st.ws.close();
});

test('odhlásená sestra prestane dostávať údaje', async () => {
  const c2 = h.client(s.base);
  await c2.post('/api/auth/login', { password: 'Testovacie-heslo-1' });
  const st = open('staff', c2.cookie);
  await st.waitFor((m) => m.type === 'staff.state');
  await c2.post('/api/auth/logout', {});
  await kiosk.post('/api/kiosk/tickets', { requestId: crypto.randomUUID() });
  assert.equal(await st.closed, 4401);
});
