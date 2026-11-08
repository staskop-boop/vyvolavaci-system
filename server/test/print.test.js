'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const h = require('./helpers');
const { fakePrinter } = require('./fake-printer');
h.freshDataDir();

let s, staff, kiosk, fp;
before(async () => {
  s = await h.start({ kioskRateLimit: 100000 }); staff = await h.setupAndLogin(s); kiosk = h.client(s.base);
  fp = await fakePrinter('ok');
});
after(async () => { await fp.close(); await s.close(); });

const setPrinter = (p) => staff.put('/api/admin/settings', { printer: { enabled: true, host: '127.0.0.1', statusTimeoutMs: 400, connectTimeoutMs: 800, ...p } });
const reg = (id) => kiosk.post('/api/kiosk/tickets', { requestId: id || crypto.randomUUID() });

test('úspešná tlač: lístok obsahuje číslo, AdNa, dátum a pokyn', async () => {
  await setPrinter({ port: fp.port });
  const r = await reg();
  assert.equal(r.data.print.status, 'ok');
  const job = fp.state.jobs.at(-1).toString('latin1');
  assert.ok(job.includes(r.data.ticket.code));
  assert.ok(job.includes('AdNa'));
  assert.ok(job.includes('Posadte sa, prosim, a sledujte obrazovku v cakarni.'), 'predvolene bez diakritiky');
  assert.match(job, /\d{1,2}\. ?\d{1,2}\. ?\d{4}/);
  assert.ok(fp.state.jobs.at(-1).includes(Buffer.from([0x1d, 0x56, 0x42, 0x00])), 'orezanie papiera');
});

test('chýba papier → failed, nič sa netlačí, číslo existuje', async () => {
  fp.state.mode = 'paperOut';
  const n = fp.state.jobs.length;
  const r = await reg();
  assert.equal(r.status, 201);
  assert.equal(r.data.print.status, 'failed');
  assert.match(r.data.print.message, /papier/);
  await new Promise((x) => setTimeout(x, 100));
  assert.equal(fp.state.jobs.length, n);
  const st = (await staff.get('/api/staff/state')).data;
  assert.equal(st.tickets.find((t) => t.id === r.data.ticket.id).print.status, 'failed');
});

test('tlačiareň neodpovedá na stav → unverified (netvrdíme, že sa vytlačilo)', async () => {
  fp.state.mode = 'silent';
  const r = await reg();
  assert.equal(r.data.print.status, 'unverified');
  assert.match(r.data.print.message, /nie je možné overiť/);
});

test('nedostupná tlačiareň → failed so zrozumiteľnou správou', async () => {
  const tmp = net.createServer(); await new Promise((x) => tmp.listen(0, '127.0.0.1', x));
  const deadPort = tmp.address().port; await new Promise((x) => tmp.close(x));
  await setPrinter({ port: deadPort });
  const r = await reg();
  assert.equal(r.data.print.status, 'failed');
  assert.match(r.data.print.message, /nedostupná/);
});

test('opakovanie požiadavky po zlyhaní tlače vytlačí ten istý lístok, nové číslo nevznikne', async () => {
  const id = crypto.randomUUID();
  const r1 = await reg(id);
  assert.equal(r1.data.print.status, 'failed');
  fp.state.mode = 'ok';
  await setPrinter({ port: fp.port });
  const r2 = await reg(id);
  assert.equal(r2.data.duplicate, true);
  assert.equal(r2.data.ticket.code, r1.data.ticket.code);
  assert.equal(r2.data.print.status, 'ok');
  const r3 = await reg(id); // tretí pokus už netlačí znova
  const jobs = fp.state.jobs.length;
  assert.equal(r3.data.print.status, 'ok');
  await new Promise((x) => setTimeout(x, 100));
  assert.equal(fp.state.jobs.length, jobs);
});

test('sestra znovu vytlačí existujúci lístok bez vytvorenia nového pacienta', async () => {
  const before = (await staff.get('/api/staff/state')).data;
  const t = before.tickets[0];
  const n = fp.state.jobs.length;
  const r = await staff.post(`/api/staff/tickets/${t.id}/reprint`, {});
  assert.equal(r.status, 200);
  assert.equal(r.data.print.status, 'ok');
  await new Promise((x) => setTimeout(x, 100));
  assert.equal(fp.state.jobs.length, n + 1);
  assert.ok(fp.state.jobs.at(-1).toString('latin1').includes(t.code));
  assert.ok(fp.state.jobs.at(-1).toString('latin1').includes('opakovana tlac'));
  const after = (await staff.get('/api/staff/state')).data;
  assert.equal(after.tickets.length, before.tickets.length);
  assert.equal(after.tickets[0].print.attempts, t.print.attempts + 1);
});

test('kódovanie CP852 – slovenské znaky', async () => {
  await setPrinter({ port: fp.port, encoding: 'cp852' });
  await reg();
  const job = fp.state.jobs.at(-1);
  assert.ok(job.includes(Buffer.from([0x1b, 0x74, 18])), 'ESC t 18');
  assert.ok(job.includes(Buffer.from([0x50, 0x6f, 0x73, 0x61, 0xd4])), 'Posa + ď (0xD4)');
});

test('overenie stavu tlačiarne z administrácie', async () => {
  const r = await staff.post('/api/admin/printer/test', {});
  assert.equal(r.data.status, 'ok');
  fp.state.mode = 'paperOut';
  assert.equal((await staff.post('/api/admin/printer/test', {})).data.status, 'failed');
  fp.state.mode = 'ok';
});
