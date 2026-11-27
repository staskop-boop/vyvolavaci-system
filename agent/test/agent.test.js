'use strict';
// Jednotkové testy agenta bez servera: porovnanie konceptu, denník, PDF, ochrana ostrého režimu.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compareDraft } = require('../src/porovnanie');
const { Journal } = require('../src/journal');
const { testPage, textPdf } = require('../src/pdf');
const { Vrp2WebDriver } = require('../src/drivers/vrp2-web');
const { build } = require('../src/index');

const job = { register: { vrpCode: '111' }, company: { name: 'AdNa s.r.o.', ico: '12345678' }, method: 'cash', totalCents: 1468, roundingCents: 2, payableCents: 1470, receivedCents: 2000,
  items: [{ name: 'Výkon A', qty: 2, unitCents: 734, totalCents: 1468 }] };
const draft = () => ({ registerCode: '111', companyIco: '12345678', items: [{ name: 'Výkon  A ', qty: 2, unitCents: 734, totalCents: 1468 }], totalCents: 1468, roundingCents: 2, payableCents: 1470, method: 'cash', receivedCents: 2000 });

test('porovnanie: zhodný koncept prejde (medzery v názve sa neberú do úvahy)', () => assert.deepEqual(compareDraft(job, draft()), []));
test('porovnanie: každá odchýlka sa pomenuje', () => {
  const m = (patch) => compareDraft(job, { ...draft(), ...patch }).join(' | ');
  assert.match(m({ registerCode: '222' }), /Aktívna pokladnica VRP2 je „222“/);
  assert.match(m({ companyIco: '99999999' }), /IČO vo VRP2 je 99999999/);
  assert.match(m({ items: [] }), /Počet položiek vo VRP2 je 0/);
  assert.match(m({ items: [{ name: 'Výkon B', qty: 2, unitCents: 734, totalCents: 1468 }] }), /vo VRP2 „Výkon B“, potvrdená „Výkon A“/);
  assert.match(m({ items: [{ name: 'Výkon A', qty: 1, unitCents: 734, totalCents: 734 }] }), /množstvo vo VRP2 1, potvrdené 2/);
  assert.match(m({ payableCents: 1468, roundingCents: 0 }), /Zaokrúhlenie vo VRP2 0,00/);
  assert.match(m({ method: 'card' }), /Platidlo vo VRP2 „karta“, potvrdené „hotovosť“/);
  assert.match(compareDraft(job, null)[0], /nevrátila koncept/);
});
test('denník prežije reštart a poškodený posledný riadok', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'adna-dennik-'));
  const j = new Journal(d);
  j.write(5, 1, 'claimed'); j.write(5, 1, 'ack'); j.write(5, 1, 'clicking'); j.write(6, 1, 'claimed');
  fs.appendFileSync(j.file, '{"paymentId":5,"att');
  assert.deepEqual(new Journal(d).steps(5, 1).map((s) => s.step), ['claimed', 'ack', 'clicking']);
  const p = j.saveOutput(5, { ext: 'pdf', data: Buffer.from('%PDF-x') });
  assert.equal(new Journal(d).loadOutput(5).data.toString(), '%PDF-x'); assert.ok(p.endsWith('doklad-5.pdf'));
});
test('skúšobná stránka je platné PDF a je zreteľne označená', () => {
  const pdf = testPage({ agentName: 'Recepcia', printerName: 'P', registerLabel: 'R', companyName: 'AdNa s.r.o.' });
  const s = pdf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4')); assert.ok(s.trimEnd().endsWith('%%EOF'));
  assert.ok(s.includes('NIE JE TO POKLADNI')); assert.ok(s.includes('Nevznikla'));
  const xref = Number(s.match(/startxref\n(\d+)/)[1]);
  assert.equal(s.slice(xref, xref + 4), 'xref');
  assert.ok(textPdf([{ text: 'x' }], { widthMm: 58 }).toString('latin1').includes('/MediaBox [0 0 164.41'));
});
test('ostrý režim sa nespustí bez povolenia v konfigurácii ani bez overeného ovládania VRP2', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'adna-live-'));
  const ov = path.join(d, 'ovl.json');
  fs.copyFileSync(path.join(__dirname, '..', 'vrp2-ovladanie.vzor.json'), ov);
  const base = { server: 'http://127.0.0.1:1', token: 'vrpa_x', data: d, vrp2: { profil: path.join(d, 'p'), ovladanie: ov } };
  assert.throws(() => build({ ...base, rezim: 'live' }), /nie je v konfigurácii povolený/);
  assert.throws(() => build({ ...base, rezim: 'live', ostryRezimPovoleny: true }), /nie je overené/);
  const drv = new Vrp2WebDriver({ profil: path.join(d, 'p'), ovladanie: ov });
  assert.equal(drv.verified(), false);
  assert.throws(() => drv.sel('vystavit'), /nie je overené/);
  assert.equal(build({ ...base, rezim: 'sim' }).driver.mode, 'sim');
});
