'use strict';
// Overenie obnovenia stavu po reštarte servera (skutočný samostatný proces, ukončený SIGKILL = „výpadok“).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const h = require('./helpers');
const dataDir = h.freshDataDir();
const PORT = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}`;
let proc;

function startProc() {
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env, ADNA_PORT: String(PORT), ADNA_HOST: '127.0.0.1', ADNA_DATA_DIR: dataDir, ADNA_QUIET: '1' }, stdio: 'ignore',
  });
  return waitUp();
}
async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server sa nespustil');
}
after(() => { try { proc.kill('SIGKILL'); } catch {} });

test('po tvrdom reštarte servera ostanú čísla, stavy, vyvolania, heslo aj nastavenia', async () => {
  await startProc();
  const code = fs.readFileSync(path.join(dataDir, 'SETUP-KOD.txt'), 'utf8').match(/KOD:\s*(\S+)/)[1];
  const staff = h.client(base);
  assert.equal((await staff.post('/api/setup', { setupCode: code, password: 'Restart-heslo-123' })).status, 200);
  await staff.post('/api/auth/login', { password: 'Restart-heslo-123' });
  const kiosk = h.client(base);
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  for (const id of ids) await kiosk.post('/api/kiosk/tickets', { requestId: id });
  const st = (await staff.get('/api/staff/state')).data;
  await staff.post('/api/staff/call-next', { roomId: st.rooms[1].id });
  await staff.put('/api/admin/settings', { recentCount: 4 });

  proc.kill('SIGKILL');
  await new Promise((r) => proc.once('exit', r));
  await startProc();

  const again = (await staff.get('/api/staff/state'));
  assert.equal(again.status, 200, 'prihlásenie sestry prežije reštart servera');
  assert.deepEqual(again.data.tickets.map((t) => [t.code, t.status]), [['A001', 'called'], ['A002', 'waiting'], ['A003', 'waiting']]);
  assert.equal(again.data.settings.recentCount, 4);
  const disp = (await kiosk.get('/api/display/state')).data;
  assert.equal(disp.current.code, 'A001'); assert.equal(disp.current.roomName, st.rooms[1].name);
  const dup = await kiosk.post('/api/kiosk/tickets', { requestId: ids[2] });
  assert.equal(dup.data.ticket.code, 'A003', 'opakovaná požiadavka po reštarte = to isté číslo');
  const n = await kiosk.post('/api/kiosk/tickets', { requestId: crypto.randomUUID() });
  assert.equal(n.data.ticket.code, 'A004', 'číslovanie pokračuje bez duplicít');
  assert.ok(!fs.existsSync(path.join(dataDir, 'SETUP-KOD.txt')), 'inštalačný kód sa po použití zmaže');
});
