'use strict';
// 2026-11-27 (Pali): platba pacienta pri ukončení návštevy → doklad vo VRP2 → tlač na recepcii.
// Overuje scenáre 1 – 9 zo zadania so skutočným serverom, skutočným agentom (agent/src) a SIMULÁTOROM VRP2.
// Simulátor nikdy nekomunikuje s Finančnou správou – v ostrej VRP2 tieto testy nevytvárajú žiadne tržby.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./helpers');
h.freshDataDir();

const { Agent, serverApi } = require('../../agent/src/agent');
const { Journal } = require('../../agent/src/journal');
const { Printer } = require('../../agent/src/tlac');
const { Vrp2Simulator, SimDriver } = require('../../agent/src/drivers/simulator');

const CODE = '00000000000000001';     // vymyslené kódy len pre simulátor – skutočné kódy pokladníc do repozitára nepatria
const CODE_UZ = '00000000000000002';
let s, admin, sestra, sestra2, room, room2, cfg, agentToken, tmp;
const opId = () => crypto.randomUUID();

function makeAgent({ simFile, journalDir, printDir, printerCfg } = {}) {
  const sim = new Vrp2Simulator(simFile || path.join(tmp, 'sim.json'));
  const agent = new Agent({ api: serverApi(s.base, agentToken), driver: new SimDriver(sim), printer: new Printer(printerCfg || { typ: 'subor', priecinok: printDir || path.join(tmp, 'tlac') }),
    journal: new Journal(journalDir || path.join(tmp, 'dennik')), name: 'test' });
  return { agent, sim };
}
/** Agent spracúva úlohy, kým nejaké sú. */
async function drain(agent, max = 20) { await agent.heartbeat(); let n = 0; while (n < max && (await agent.runOnce())) n++; return n; }

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adna-vrp2-'));
  s = await h.start({ kioskRateLimit: 100000 }); admin = await h.setupAndLogin(s);
  const rooms = (await admin.get('/api/admin/rooms')).data.rooms;
  room = rooms[0]; room2 = rooms[1];
  await admin.post('/api/admin/users', { username: 'sestra1', password: 'Heslo-sestry-01', roomId: room.id, nurseName: 'Daniela Fetyková' });
  await admin.post('/api/admin/users', { username: 'sestra2', password: 'Heslo-sestry-02', roomId: room.id });
  sestra = h.client(s.base); sestra2 = h.client(s.base);
  assert.equal((await sestra.post('/api/auth/login', { username: 'sestra1', password: 'Heslo-sestry-01' })).status, 200);
  assert.equal((await sestra2.post('/api/auth/login', { username: 'sestra2', password: 'Heslo-sestry-02' })).status, 200);

  const b = (await admin.get('/api/admin/billing')).data;
  assert.deepEqual(b.companies.map((c) => c.name), ['AdNa s.r.o.', 'Ultrazvukové pracovisko s.r.o.'], 'obe spoločnosti sú pripravené');
  assert.equal(b.config.enabled, false, 'po nasadení sú platby vypnuté');
  const adna = b.companies[0], uz = b.companies[1];
  const ag = await admin.post('/api/admin/billing/agents', { name: 'Recepcia 1' });
  assert.equal(ag.status, 201); agentToken = ag.data.token;
  assert.ok(!JSON.stringify((await admin.get('/api/admin/billing')).data).includes(agentToken), 'token sa ukáže len raz');
  const reg = await admin.post('/api/admin/billing/registers', { companyId: adna.id, label: 'AdNa – recepcia', vrpCode: CODE, agentId: ag.data.agent.id, printerName: 'Recepcia-80mm', roomIds: [room.id] });
  assert.equal(reg.status, 201, JSON.stringify(reg.data)); assert.equal(reg.data.mode, 'sim', 'nová pokladnica je v simulátore');
  const reg2 = await admin.post('/api/admin/billing/registers', { companyId: uz.id, label: 'Ultrazvuk – recepcia', vrpCode: CODE_UZ, agentId: ag.data.agent.id, printerName: 'Recepcia-80mm', roomIds: [room.id] });
  // cenník: riadky skopírované z exportu VRP2 „Tovary a služby“ (formát overený na skutočnom exporte)
  const tsv = [
    'Označenie tovaru/služby\tEAN\tKód tovaru\tCena s DPH\tCena bez DPH\tPlatnosť od\tPlatnosť do',
    'Komplexné cievne vyšetrenie - samoplatca\t\t\t150\t150\t2026-09-01 08:19:56\t',
    'EVLA - odstránenie kŕčových žíl \t\t\t1000\t1000\t2026-03-31 14:22:17\t',
    'EVLA (VSM+VSP)\t\t\t1400\t1400\t2026-08-31 15:22:54\t',
    'CLaCS - odstránenie varixov (Laser+sklerotizácia), 1 impulz \t\t\t4,1\t4,1\t2026-08-31 15:21:51\t',
    'Ag test - Covid 19\t\t\t\t\t2026-09-28 13:04:15\t',
    'Stará položka\t\t\t10\t10\t2020-01-01\t2021-01-01',
  ].join('\n');
  const imp = await admin.post('/api/admin/billing/price-import', { companyId: adna.id, text: tsv });
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  assert.equal(imp.data.added, 5); assert.equal(imp.data.skipped, 2, 'hlavička a neplatná položka sa preskočia');
  await admin.post('/api/admin/billing/price-items', { companyId: uz.id, name: 'Duplexná sonografia', priceCents: 6000 });
  const items = (await admin.get('/api/admin/billing')).data.priceItems;
  const it = (n) => items.find((i) => i.name.startsWith(n)).id;
  const pr = (name, list) => admin.post('/api/admin/billing/procedures', { name, items: list });
  const cievne = (await pr('Cievne vyšetrenie', [{ variant: '', priceItemId: it('Komplexné cievne') }])).data;
  const evla = (await pr('EVLA', [{ variant: 'one', priceItemId: it('EVLA - odstr') }, { variant: 'both', priceItemId: it('EVLA (VSM+VSP)') }])).data;
  const clacs = (await pr('CLaCS', [{ variant: '', priceItemId: it('CLaCS'), qty: 100 }])).data;
  const covid = (await pr('Ag test', [{ variant: '', priceItemId: it('Ag test') }])).data;
  const sono = (await pr('Duplexná sonografia', [{ variant: '', priceItemId: it('Duplexná') }])).data;
  const bezMap = (await pr('Sklerotizácia', [])).data;
  cfg = { adna, uz, agentId: ag.data.agent.id, reg: reg.data, reg2: reg2.data, cievne, evla, clacs, covid, sono, bezMap };
  const simInit = { registers: [{ code: CODE, companyName: 'AdNa s.r.o.', ico: '' }, { code: CODE_UZ, companyName: 'Ultrazvukové pracovisko s.r.o.', ico: '' }], activeCode: CODE,
    catalog: { [CODE]: [{ name: 'Komplexné cievne vyšetrenie - samoplatca', priceCents: 15000 }, { name: 'EVLA - odstránenie kŕčových žíl', priceCents: 100000 },
      { name: 'EVLA (VSM+VSP)', priceCents: 140000 }, { name: 'CLaCS - odstránenie varixov (Laser+sklerotizácia), 1 impulz', priceCents: 410 }],
    [CODE_UZ]: [{ name: 'Duplexná sonografia', priceCents: 6000 }] } };
  new Vrp2Simulator(path.join(tmp, 'sim.json'), simInit);
});
after(() => s.close());

let seq = 0;
async function patient(c = sestra) {
  const r = await c.post('/api/staff/cards', { cardNo: 'P' + (++seq), plannedTime: '23:' + String(seq % 60).padStart(2, '0'), roomId: room.id });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = r.data.ticket.id;
  assert.equal((await c.post(`/api/staff/tickets/${id}/call`, { roomId: room.id })).status, 200);
  return id;
}
const finish = (c, id, body) => c.post(`/api/staff/tickets/${id}/finish`, { opId: opId(), registerId: cfg.reg.id, paymentConfirmed: true, ...body });
const state = async () => (await admin.get('/api/staff/state')).data;
const pay = async (pid) => (await admin.get(`/api/staff/payments/${pid}`)).data.payment;
const count = (sql, ...a) => s.db.prepare(sql).get(...a).n;

test('zapnutie platieb; pred zapnutím platbu nemožno prijať', async () => {
  const id = await patient();
  const r = await finish(sestra, id, { method: 'card', cardApproved: true, lines: [{ procedureId: cfg.cievne.id, qty: 1 }], expectedPayableCents: 15000 });
  assert.equal(r.status, 409);
  assert.equal((await sestra.put('/api/admin/billing/config', { enabled: true })).status, 403, 'sestra nie je správca');
  assert.equal((await admin.put('/api/admin/billing/config', { enabled: true })).status, 200);
  assert.equal((await sestra.post(`/api/staff/tickets/${id}/done`, {})).status, 200);
});

test('1. návšteva bez úhrady sa ukončí pôvodným spôsobom – žiadna platba ani úloha', async () => {
  const before = count('SELECT COUNT(*) AS n FROM payments');
  const id = await patient();
  const r = await sestra.post(`/api/staff/tickets/${id}/done`, {});
  assert.equal(r.status, 200); assert.equal(r.data.ticket.status, 'done');
  assert.equal(count('SELECT COUNT(*) AS n FROM payments'), before);
  assert.equal((await state()).billing.payments[id], undefined);
  assert.equal((await sestra.post(`/api/staff/tickets/${id}/requeue`, {})).status, 200, 'vrátenie omylom ukončeného bez platby funguje ako doteraz');
  await sestra.post(`/api/staff/tickets/${id}/done`, {});
});

test('formulár: chýbajúca cena, mapovanie a variant končatiny sa ukážu pred prijatím platby', async () => {
  const id = await patient();
  const f = (await sestra.get(`/api/staff/tickets/${id}/finish-form`)).data;
  assert.equal(f.registers.length, 2, 'recepcia slúži obom spoločnostiam');
  assert.deepEqual(f.registers.map((g) => g.companyName).sort(), ['AdNa s.r.o.', 'Ultrazvukové pracovisko s.r.o.']);
  const base = { method: 'card', cardApproved: true, expectedPayableCents: 0 };
  let r = await finish(sestra, id, { ...base, lines: [{ procedureId: cfg.covid.id, qty: 1 }] });
  assert.equal(r.status, 400); assert.match(r.data.error.message, /nemá v cenníku cenu/);
  r = await finish(sestra, id, { ...base, lines: [{ procedureId: cfg.bezMap.id, qty: 1 }] });
  assert.equal(r.status, 400); assert.match(r.data.error.message, /nemá priradenú položku VRP2/);
  r = await finish(sestra, id, { ...base, lines: [{ procedureId: cfg.evla.id, qty: 1 }] });
  assert.equal(r.status, 400); assert.match(r.data.error.message, /jednu alebo obe končatiny/);
  r = await finish(sestra, id, { ...base, lines: [{ procedureId: cfg.sono.id, qty: 1 }] });
  assert.equal(r.status, 400, 'položka inej spoločnosti na pokladnici AdNa'); assert.match(r.data.error.message, /inej spoločnosti/);
  r = await finish(sestra, id, { method: 'card', lines: [{ procedureId: cfg.cievne.id, qty: 1 }], expectedPayableCents: 15000 });
  assert.equal(r.status, 400, 'karta bez potvrdenia terminálu');
  assert.equal((await ticketOf(id)).status, 'called', 'návšteva ostáva otvorená');
  await sestra.post(`/api/staff/tickets/${id}/done`, {});
});
const ticketOf = async (id) => (await state()).tickets.find((t) => t.id === id);

test('2. dva platené výkony + schválená karta = jedna ukončená návšteva, jedna platba, jeden doklad, tlač', async () => {
  const id = await patient();
  const lines = [{ procedureId: cfg.cievne.id, qty: 1 }, { procedureId: cfg.evla.id, variant: 'both', qty: 1 }];
  const r = await finish(sestra, id, { method: 'card', cardApproved: true, lines, expectedPayableCents: 155000 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.ticket.status, 'done');
  const p = r.data.payment;
  assert.equal(p.payableCents, 155000); assert.equal(p.roundingCents, 0, 'karta sa nezaokrúhľuje');
  assert.deepEqual(p.items.map((i) => [i.name, i.qty, i.unitCents, i.variant]), [['Komplexné cievne vyšetrenie - samoplatca', 1, 15000, ''], ['EVLA (VSM+VSP)', 1, 140000, 'obe končatiny']]);
  assert.equal(p.status.text, 'SIMULÁCIA · Platba prijatá · čaká na agenta.');
  assert.equal(p.companyName, 'AdNa s.r.o.'); assert.equal(p.confirmedBy, 'Daniela Fetyková');
  const { agent, sim } = makeAgent();
  await drain(agent);
  const q = await pay(p.id);
  assert.equal(q.receiptStatus, 'issued'); assert.match(q.receipt.id, /^SIM-/); assert.equal(q.receipt.simulated, true);
  assert.equal(q.print.status, 'sent');
  assert.equal(q.status.text, 'SIMULÁCIA · doklad nie je fiskalizovaný · odoslané na tlačiareň.', 'simulovaný doklad sa nikdy neukáže ako fiskalizovaný');
  assert.equal(count('SELECT COUNT(*) AS n FROM payments WHERE ticket_id = ?', id), 1);
  assert.equal(sim.issuedList().filter((x) => x.reference === p.id || x.id === q.receipt.id).length, 1, 'vo VRP2 jeden doklad');
  const pdf = fs.readdirSync(path.join(tmp, 'tlac')).filter((f) => f.includes(`doklad-${p.id}-original`));
  assert.equal(pdf.length, 1, 'originál bol odoslaný na tlačiareň bez dialógu');
  assert.ok(fs.readFileSync(path.join(tmp, 'tlac', pdf[0]), 'latin1').includes('SIMUL'), 'výtlačok je označený ako simulácia');
  // história návštevy: úhrada aj ID toho istého dokladu
  const hist = (await admin.get('/api/staff/history?day=' + (await state()).day)).data;
  const hp = hist.payments.find((x) => x.ticketId === id);
  assert.equal(hp.receipt.id, q.receipt.id); assert.ok(hp.events.some((e) => e.type === 'confirmed' && e.userName === 'Daniela Fetyková'));
  assert.equal((await state()).billing.payments[id].receiptId, q.receipt.id);
  // agent nedostáva údaje o pacientovi
  assert.equal((await sestra.post(`/api/staff/tickets/${id}/requeue`, {})).status, 409, 'návštevu s platbou nemožno vrátiť');
});

test('agent dostane len údaje potrebné na doklad – bez identifikátora, typu pacienta a čísla', async () => {
  const r = await sestra.post('/api/staff/cards', { cardNo: 'NOTE1', plannedTime: '22:00', roomId: room.id, staffNote: 'Ján Tajný 801231/1234', patientType: 'Kontrola varixy' });
  const id = r.data.ticket.id;
  await sestra.post(`/api/staff/tickets/${id}/call`, { roomId: room.id });
  await finish(sestra, id, { method: 'card', cardApproved: true, lines: [{ procedureId: cfg.cievne.id, qty: 1 }], expectedPayableCents: 15000 });
  const api = serverApi(s.base, agentToken);
  await api.post('/api/agent/heartbeat', { mode: 'sim', session: 'ok' });
  const { job } = await api.post('/api/agent/claim', { mode: 'sim', session: 'ok' });
  const txt = JSON.stringify(job);
  for (const bad of ['Tajný', '801231', 'Kontrola varixy', 'NOTE1', 'Fetyková']) assert.ok(!txt.includes(bad), `agent nedostal „${bad}“`);
  assert.equal(job.payment.company.name, 'AdNa s.r.o.'); assert.equal(job.payment.register.vrpCode, CODE);
  // dokončiť úlohu riadne
  const { agent } = makeAgent(); await agent.heartbeat(); await agent.doIssue(job.payment); await drain(agent);
  assert.equal(s.db.prepare('SELECT receipt_status FROM payments WHERE ticket_id = ?').get(id).receipt_status, 'issued');
});

test('3. hotovosť: zaokrúhlenie na 5 centov a výdavok; nedostatočná suma sa odmietne', async () => {
  const id = await patient();
  const lines = [{ procedureId: cfg.clacs.id, qty: 37 }];   // 37 × 4,10 € = 151,70 €
  let r = await finish(sestra, id, { method: 'cash', receivedCents: 15000, lines, expectedPayableCents: 15170 });
  assert.equal(r.status, 400); assert.match(r.data.error.message, /nižšia/);
  r = await finish(sestra, id, { method: 'cash', receivedCents: 20000, lines, expectedPayableCents: 15170 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.payment.totalCents, 15170); assert.equal(r.data.payment.roundingCents, 0); assert.equal(r.data.payment.changeCents, 4830);
  const id2 = await patient();
  const r2 = await finish(sestra, id2, { method: 'cash', receivedCents: 5000, lines: [{ procedureId: cfg.clacs.id, qty: 3 }], expectedPayableCents: 1230 });  // 12,30 → 12,30
  assert.equal(r2.data.payment.roundingCents, 0);
  const id3 = await patient();
  const r3 = await finish(sestra, id3, { method: 'cash', receivedCents: 2000, lines: [{ procedureId: cfg.clacs.id, qty: 4 }], expectedPayableCents: 1640 });   // 16,40
  assert.equal(r3.status, 201);
  const { agent } = makeAgent(); await drain(agent);
  for (const p of [r.data.payment, r2.data.payment, r3.data.payment]) assert.equal((await pay(p.id)).receiptStatus, 'issued');
});

test('3b. zaokrúhlenie hotovosti podľa pravidiel SR (jednotkový test výpočtu)', () => {
  const m = require('../../shared/peniaze.js');
  const cases = { 1460: 0, 1461: -1, 1462: -2, 1463: 2, 1464: 1, 1465: 0, 1466: -1, 1467: -2, 1468: 2, 1469: 1 };
  for (const [c, r] of Object.entries(cases)) assert.equal(m.cashRounding(Number(c)), r, `${c} centov`);
  assert.deepEqual(m.compute([{ unitCents: 1468, qty: 1 }], 'card'), { totalCents: 1468, roundingCents: 0, payableCents: 1468, changeCents: null, enough: true });
  assert.deepEqual(m.compute([{ unitCents: 1468, qty: 1 }], 'cash', 2000), { totalCents: 1468, roundingCents: 2, payableCents: 1470, changeCents: 530, enough: true });
  assert.equal(m.cashRounding(1), 4); assert.equal(m.cashRounding(2), 3); assert.equal(m.cashRounding(0), 0);
  assert.equal(m.parseEur('4,1'), 410); assert.equal(m.parseEur('12.05'), 1205); assert.equal(m.parseEur('1,234'), null);
});

test('4. zamietnutá karta nevytvorí uhradenú návštevu ani úlohu; potom hotovosť', async () => {
  const id = await patient();
  const before = count('SELECT COUNT(*) AS n FROM payments');
  const op = opId();
  const r = await sestra.post(`/api/staff/tickets/${id}/finish`, { opId: op, registerId: cfg.reg.id, method: 'card', cardApproved: false, paymentConfirmed: true, lines: [{ procedureId: cfg.cievne.id, qty: 1 }], expectedPayableCents: 15000 });
  assert.equal(r.status, 400);
  assert.equal(count('SELECT COUNT(*) AS n FROM payments'), before);
  assert.equal((await ticketOf(id)).status, 'called', 'návšteva nie je ukončená');
  const r2 = await sestra.post(`/api/staff/tickets/${id}/finish`, { opId: op, registerId: cfg.reg.id, method: 'cash', receivedCents: 15000, paymentConfirmed: true, lines: [{ procedureId: cfg.cievne.id, qty: 1 }], expectedPayableCents: 15000 });
  assert.equal(r2.status, 201, 'zmena spôsobu úhrady po zamietnutí');
  const { agent } = makeAgent(); await drain(agent);
});

test('5. dvojklik, obnovenie stránky a dve sestry naraz = jedna platba, jeden doklad', async () => {
  const id = await patient();
  const body = (op) => ({ opId: op, registerId: cfg.reg.id, method: 'card', cardApproved: true, paymentConfirmed: true, lines: [{ procedureId: cfg.cievne.id, qty: 1 }], expectedPayableCents: 15000 });
  const op = opId();
  // dvojklik: 10 rovnakých požiadaviek naraz
  const rs = await Promise.all(Array.from({ length: 10 }, () => sestra.post(`/api/staff/tickets/${id}/finish`, body(op))));
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
  assert.ok(rs.every((r) => r.status === 201 || (r.status === 200 && r.data.duplicate) || r.status === 409), rs.map((r) => r.status).join(','));
  // obnovenie stránky = nový formulár (nové opId) na tú istú návštevu
  const again = await sestra.post(`/api/staff/tickets/${id}/finish`, body(opId()));
  assert.equal(again.status, 409); assert.match(again.data.error.message, /už má zaevidovanú platbu/);
  // dve sestry naraz s rôznymi opId na ďalšej návšteve
  const id2 = await patient();
  const two = await Promise.all([sestra.post(`/api/staff/tickets/${id2}/finish`, body(opId())), sestra2.post(`/api/staff/tickets/${id2}/finish`, body(opId()))]);
  assert.deepEqual(two.map((r) => r.status).sort(), [201, 409]);
  // sestra ukončí bez platby, kým druhá potvrdzuje platbu
  const id3 = await patient();
  const mix = await Promise.all([sestra.post(`/api/staff/tickets/${id3}/done`, {}), sestra2.post(`/api/staff/tickets/${id3}/finish`, body(opId()))]);
  assert.equal(mix.filter((r) => r.status < 300).length, 1, 'buď ukončenie, alebo platba');
  for (const t of [id, id2, id3]) assert.ok(count('SELECT COUNT(*) AS n FROM payments WHERE ticket_id = ?', t) <= 1);
  // dva agenti naraz nevezmú tú istú úlohu
  const A = makeAgent(), B = makeAgent({ journalDir: path.join(tmp, 'dennik-b') });
  await Promise.all([A.agent.heartbeat(), B.agent.heartbeat()]);
  // (dva procesy s tým istým tokenom sú chybná inštalácia – jeden z nich môže dostať odmietnutie, duplicitný doklad vzniknúť nesmie)
  await Promise.allSettled([drain(A.agent), drain(B.agent)]);
  await drain(A.agent);
  const ids = s.db.prepare('SELECT receipt_id FROM payments WHERE ticket_id IN (?, ?, ?) AND receipt_id IS NOT NULL').all(id, id2, id3).map((r) => r.receipt_id);
  assert.equal(new Set(ids).size, ids.length);
  const simIds = A.sim.issuedList().map((x) => x.reference);
  assert.equal(simIds.length, new Set(simIds).size, 'žiadny doklad vo VRP2 dvakrát');
  // čo pri súbehu ostalo „na overenie“, dorieši správca podľa evidencie – tu len upraceme pre ďalšie testy
  for (const u of s.db.prepare("SELECT id, op_id FROM payments WHERE receipt_status NOT IN ('issued')").all()) {
    const d = A.sim.issuedList().find((x) => x.reference === u.op_id);
    if (d) await admin.post(`/api/admin/payments/${u.id}/resolve`, { action: 'confirm-issued', receiptId: d.id });
  }
  await drain(A.agent);
});

test('6. dve návštevy s rovnakou sumou v tej istej minúte dostanú každá svoj doklad', async () => {
  const a = await patient(), b = await patient();
  const L = { method: 'card', cardApproved: true, lines: [{ procedureId: cfg.cievne.id, qty: 1 }], expectedPayableCents: 15000 };
  const pa = (await finish(sestra, a, L)).data.payment, pb = (await finish(sestra2, b, L)).data.payment;
  const { agent, sim } = makeAgent(); await drain(agent);
  const ra = await pay(pa.id), rb = await pay(pb.id);
  assert.notEqual(ra.receipt.id, rb.receipt.id);
  const issued = sim.issuedList();
  assert.equal(issued.find((x) => x.id === ra.receipt.id).reference, s.db.prepare('SELECT op_id FROM payments WHERE id = ?').get(pa.id).op_id);
  assert.equal(issued.find((x) => x.id === rb.receipt.id).reference, s.db.prepare('SELECT op_id FROM payments WHERE id = ?').get(pb.id).op_id);
});

test('7. nesprávna spoločnosť vo VRP2, chýbajúca položka a odlišná suma zastavia agenta pred vystavením', async () => {
  const { agent, sim } = makeAgent();
  const issuedBefore = sim.issuedList().length;
  const L = { method: 'card', cardApproved: true, lines: [{ procedureId: cfg.cievne.id, qty: 1 }], expectedPayableCents: 15000 };
  // a) vo VRP2 je aktívna pokladnica druhej spoločnosti
  sim.set({ activeCode: CODE_UZ });
  const p1 = (await finish(sestra, await patient(), L)).data.payment;
  await drain(agent);
  let q = await pay(p1.id);
  assert.equal(q.receiptStatus, 'mismatch'); assert.match(q.lastError, /aktívna pokladnica „00000000000000002“/);
  assert.equal(q.status.text, 'SIMULÁCIA · Platba prijatá · doklad nevydaný – údaje vo VRP2 nesedia, rieši správca.');
  sim.set({ activeCode: CODE });
  // b) položka vo VRP2 chýba
  const cat = sim.st.catalog; const saved = structuredClone(cat);
  sim.set({ catalog: { ...cat, [CODE]: cat[CODE].filter((x) => !x.name.startsWith('Komplexné')) } });
  const p2 = (await finish(sestra, await patient(), L)).data.payment;
  await drain(agent);
  q = await pay(p2.id); assert.equal(q.receiptStatus, 'mismatch'); assert.match(q.lastError, /v katalógu tovarov a služieb VRP2 neexistuje/);
  // c) cena vo VRP2 je iná ako v cenníku AdNa
  sim.set({ catalog: { ...saved, [CODE]: saved[CODE].map((x) => (x.name.startsWith('Komplexné') ? { ...x, priceCents: 16000 } : x)) } });
  const p3 = (await finish(sestra, await patient(), L)).data.payment;
  await drain(agent);
  q = await pay(p3.id); assert.equal(q.receiptStatus, 'mismatch');
  assert.match(q.lastError, /jednotková cena vo VRP2 160,00 €, potvrdená 150,00 €/); assert.match(q.lastError, /Celková suma/);
  // d) VRP2 vynechá položku / iné množstvo
  sim.set({ catalog: saved }); sim.fault('qtyOverride', { 'Komplexné cievne vyšetrenie - samoplatca': 2 });
  const p4 = (await finish(sestra, await patient(), L)).data.payment;
  await drain(agent);
  q = await pay(p4.id); assert.match(q.lastError, /množstvo vo VRP2 2, potvrdené 1/);
  sim.fault('qtyOverride', null);
  assert.equal(sim.issuedList().length, issuedBefore, 'ani jeden doklad sa nevystavil');
  // po oprave správca pošle úlohy znova – nič z nich sa predtým neodoslalo
  assert.equal((await sestra.post(`/api/admin/payments/${p1.id}/resolve`, { action: 'retry' })).status, 403, 'sestra výnimky nerieši');
  for (const p of [p1, p2, p3, p4]) assert.equal((await admin.post(`/api/admin/payments/${p.id}/resolve`, { action: 'retry' })).status, 200);
  await drain(agent);
  for (const p of [p1, p2, p3, p4]) assert.equal((await pay(p.id)).receiptStatus, 'issued');
  const ev = (await pay(p1.id)).events;
  assert.ok(ev.some((e) => e.type === 'retry' && e.userName === 'admin'), 'zaznamenané, kto chybu riešil');
});

test('relácia VRP2 vypršala → „treba obnoviť prihlásenie“; po prihlásení pokračuje sám', async () => {
  const { agent, sim } = makeAgent();
  sim.set({ session: 'expired' });
  await agent.heartbeat();
  const f = (await sestra.get(`/api/staff/tickets/${await patient()}/finish-form`)).data;
  assert.ok(f.registers[0].warnings.some((w) => /obnoviť prihlásenie/.test(w.text)), 'sestra je upozornená už vo formulári');
  const p = (await finish(sestra, f.ticket.id, { method: 'card', cardApproved: true, lines: [{ procedureId: cfg.cievne.id, qty: 1 }], expectedPayableCents: 15000 })).data.payment;
  assert.equal(p.status.text, 'SIMULÁCIA · Platba prijatá · treba obnoviť prihlásenie do VRP2.');
  await drain(agent);
  assert.equal((await pay(p.id)).receiptStatus, 'queued', 'bez relácie si agent úlohu nevezme');
  sim.fault('sessionExpiresOnPrepare');
  sim.set({ session: 'ok' });
  await drain(agent);
  assert.equal((await pay(p.id)).receiptStatus, 'needs_session');
  sim.fault('sessionExpiresOnPrepare', false); sim.set({ session: 'ok' });
  await drain(agent);
  assert.equal((await pay(p.id)).receiptStatus, 'issued');
});

test('8. pád agenta po odoslaní do VRP2 nespustí slepé opakovanie; overí sa podľa denníka / evidencie', async () => {
  const L = { method: 'card', cardApproved: true, lines: [{ procedureId: cfg.cievne.id, qty: 1 }], expectedPayableCents: 15000 };
  // a) doklad vydaný, agent spadol skôr, ako to stihol zapísať aj nahlásiť → po reštarte nájde doklad v evidencii (simulátor)
  const A = makeAgent();
  const p = (await finish(sestra, await patient(), L)).data.payment;
  A.sim.fault('crashAfterIssue');
  await A.agent.heartbeat();
  await assert.rejects(A.agent.runOnce(), /SIMULOVANÝ PÁD/);
  assert.equal((await pay(p.id)).receiptStatus, 'submitting');
  assert.equal((await pay(p.id)).status.text, 'SIMULÁCIA · Platba prijatá · pripravuje sa doklad.');
  const nBefore = A.sim.issuedList().length;
  const A2 = makeAgent();  // „reštart“ – nový proces, ten istý denník a simulátor
  await drain(A2.agent);
  const q = await pay(p.id);
  assert.equal(q.receiptStatus, 'issued'); assert.equal(A2.sim.issuedList().length, nBefore, 'žiadny druhý doklad');
  assert.ok(q.events.some((e) => e.type === 'issued' && /overené po reštarte/.test(e.note)));
  // b) spoľahlivé overenie nie je k dispozícii (ako v ostrej VRP2) → kontrola poverenou osobou, platba ostáva
  const B = makeAgent();
  const p2 = (await finish(sestra, await patient(), L)).data.payment;
  B.sim.fault('uncertainAfterIssue'); B.sim.fault('noReliableLookup');
  await drain(B.agent);
  let r = await pay(p2.id);
  assert.equal(r.receiptStatus, 'unverified');
  assert.equal(r.status.text, 'SIMULÁCIA · Platba prijatá · vydanie dokladu treba overiť.');
  const n2 = B.sim.issuedList().length;
  await drain(makeAgent().agent);
  assert.equal(B.sim.issuedList().length, n2, 'ani ďalší agent nevystaví druhý doklad');
  assert.equal((await admin.post(`/api/admin/payments/${p2.id}/resolve`, { action: 'retry' })).status, 409, 'po začatom odoslaní nemožno „len zopakovať“');
  assert.throws(() => s.db.prepare("UPDATE payments SET receipt_status = 'queued' WHERE id = ?").run(p2.id), /nemožno automaticky zopakovať/, 'chráni aj databáza');
  // poverená osoba našla doklad v evidencii VRP2 a priradí jeho ID
  const real = B.sim.issuedList().find((x) => x.reference === s.db.prepare('SELECT op_id FROM payments WHERE id = ?').get(p2.id).op_id);
  r = (await admin.post(`/api/admin/payments/${p2.id}/resolve`, { action: 'confirm-issued', receiptId: real.id, receiptNumber: real.number, note: 'overené v zozname dokladov' })).data.payment;
  assert.equal(r.receiptStatus, 'issued'); assert.equal(r.receipt.id, real.id);
  assert.ok(r.events.some((e) => e.type === 'manual_issued' && e.userName === 'admin'));
  B.sim.fault('noReliableLookup', false);
  // c) pád medzi potvrdením „submitting“ a kliknutím → podľa denníka sa nekliklo → nový pokus, jeden doklad
  const C = makeAgent();
  const p3 = (await finish(sestra, await patient(), L)).data.payment;
  await C.agent.heartbeat();
  const { job } = await serverApi(s.base, agentToken).post('/api/agent/claim', { mode: 'sim', session: 'ok' });
  C.agent.journal.write(job.payment.paymentId, job.payment.attempt, 'claimed');
  await serverApi(s.base, agentToken).post(`/api/agent/payments/${p3.id}/submitting`, { claimToken: job.payment.claimToken, attempt: job.payment.attempt });
  C.agent.journal.write(job.payment.paymentId, job.payment.attempt, 'ack');
  const n3 = C.sim.issuedList().length;
  await drain(makeAgent().agent);
  const r3 = await pay(p3.id);
  assert.equal(r3.receiptStatus, 'issued'); assert.equal(r3.attempt, 2); assert.equal(C.sim.issuedList().length, n3 + 1);
});

test('9. chyba tlače: doklad ostáva vydaný, opakuje sa len tlač pôvodného dokladu (kópia)', async () => {
  const L = { method: 'card', cardApproved: true, lines: [{ procedureId: cfg.cievne.id, qty: 1 }], expectedPayableCents: 15000 };
  const bad = makeAgent({ printerCfg: { typ: 'subor', priecinok: path.join(tmp, 'tlac2'), chyba: 'Došiel papier' } });
  const id = await patient();
  const p = (await finish(sestra, id, L)).data.payment;
  const n = bad.sim.issuedList().length;
  await drain(bad.agent);
  let q = await pay(p.id);
  assert.equal(q.receiptStatus, 'issued'); assert.equal(q.print.status, 'failed');
  assert.equal(q.status.text, 'SIMULÁCIA · doklad nie je fiskalizovaný · chyba tlače.'); assert.equal(q.status.action, 'reprint');
  assert.equal((await ticketOf(id)).status, 'done', 'návšteva ostáva ukončená');
  const open = (await sestra.get('/api/staff/receipts')).data.items;
  assert.ok(open.some((x) => x.id === p.id), 'je v zozname Doklady na doriešenie');
  assert.ok(open.every((x) => x.status && x.payableCents != null));
  const rp = await sestra.post(`/api/staff/payments/${p.id}/reprint`, {});
  assert.equal(rp.status, 200);
  assert.equal((await sestra.post(`/api/staff/payments/${p.id}/reprint`, {})).data.duplicate, true, 'dvojklik nevytvorí dve tlače');
  const ok = makeAgent({ printerCfg: { typ: 'subor', priecinok: path.join(tmp, 'tlac3'), potvrdzuje: true } });
  await drain(ok.agent);
  q = await pay(p.id);
  assert.equal(q.print.status, 'printed'); assert.equal(q.print.kind, 'copy');
  assert.equal(q.status.text, 'SIMULÁCIA · doklad nie je fiskalizovaný · vytlačené.', '„vytlačené“ len pri potvrdení tlačiarne');
  assert.equal(ok.sim.issuedList().length, n + 1, 'opakovaná tlač nevystavila nový doklad');
  const out = fs.readdirSync(path.join(tmp, 'tlac3'));
  assert.ok(fs.readFileSync(path.join(tmp, 'tlac3', out.find((f) => f.includes('copy'))), 'latin1').includes('K\xd3PIA'), 'kópia je označená');
  assert.ok(!(await sestra.get('/api/staff/receipts')).data.items.some((x) => x.id === p.id), 'vyriešené zmizne zo zoznamu');
});

test('skúšobná tlač: označená testovacia stránka bez dokladu a tržby', async () => {
  const { agent, sim } = makeAgent({ printDir: path.join(tmp, 'tlac-test') });
  const n = sim.issuedList().length, np = count('SELECT COUNT(*) AS n FROM payments');
  const r = await admin.post(`/api/admin/billing/registers/${cfg.reg.id}/test-print`, {});
  assert.equal(r.status, 201);
  await drain(agent);
  assert.equal((await admin.get(`/api/admin/billing/print-jobs/${r.data.jobId}`)).data.print.status, 'sent');
  const f = fs.readdirSync(path.join(tmp, 'tlac-test'));
  assert.equal(f.length, 1); assert.ok(fs.readFileSync(path.join(tmp, 'tlac-test', f[0]), 'latin1').includes('SK\xdaŠOBN'.replace('Š', 'S')));
  assert.equal(sim.issuedList().length, n); assert.equal(count('SELECT COUNT(*) AS n FROM payments'), np);
});

test('ostrý režim: len vedomý krok správcu; simulovaný doklad ostrá pokladnica neprijme a naopak', async () => {
  assert.equal((await admin.post(`/api/admin/billing/registers/${cfg.reg.id}/mode`, { mode: 'live' })).status, 400, 'bez slova OSTRÁ');
  assert.match((await admin.post(`/api/admin/billing/registers/${cfg.reg.id}/mode`, { mode: 'live', confirm: 'OSTRÁ' })).data.error.message, /IČO/);
  await admin.put(`/api/admin/billing/companies/${cfg.adna.id}`, { name: 'AdNa s.r.o.', ico: '12345678' });
  const lv = await admin.post(`/api/admin/billing/registers/${cfg.reg.id}/mode`, { mode: 'live', confirm: 'OSTRÁ' });
  assert.equal(lv.status, 200); assert.equal(lv.data.mode, 'live');
  const id = await patient();
  const p = (await finish(sestra, id, { method: 'card', cardApproved: true, lines: [{ procedureId: cfg.cievne.id, qty: 1 }], expectedPayableCents: 15000 })).data.payment;
  assert.equal(p.simulated, false); assert.equal(p.status.text.startsWith('SIMULÁCIA'), false);
  // agent v režime simulátora ostrú úlohu nedostane
  const { agent } = makeAgent();
  await drain(agent);
  assert.equal((await pay(p.id)).receiptStatus, 'queued');
  // ani podvrhnutý simulovaný výsledok
  const api = serverApi(s.base, agentToken);
  const { job } = await api.post('/api/agent/claim', { mode: 'live', session: 'ok' });
  await api.post(`/api/agent/payments/${p.id}/submitting`, { claimToken: job.payment.claimToken, attempt: job.payment.attempt });
  await assert.rejects(api.post(`/api/agent/payments/${p.id}/result`, { claimToken: job.payment.claimToken, outcome: 'issued', receipt: { id: 'SIM-X', simulated: true, registerCode: CODE } }), /simulovaný doklad/);
  await api.post(`/api/agent/payments/${p.id}/result`, { claimToken: job.payment.claimToken, outcome: 'unverified', detail: 'test' });
  // nemenná kópia platby: zmena cenníka ani pokladnice nezmení potvrdenú platbu
  await admin.put(`/api/admin/billing/price-items/${p.items[0].priceItemId}`, { companyId: cfg.adna.id, name: p.items[0].name, priceCents: 99900 });
  assert.equal((await pay(p.id)).items[0].unitCents, 15000);
  assert.throws(() => s.db.prepare('UPDATE payments SET payable_cents = 1 WHERE id = ?').run(p.id), /nemenné/);
  assert.throws(() => s.db.prepare('DELETE FROM payments WHERE id = ?').run(p.id), /nemaže/);
  await admin.post(`/api/admin/billing/registers/${cfg.reg.id}/mode`, { mode: 'sim' });
  await admin.put(`/api/admin/billing/price-items/${p.items[0].priceItemId}`, { companyId: cfg.adna.id, name: p.items[0].name, priceCents: 15000 });
});

test('migrácia: staršie návštevy nedostanú platbu ani úlohu; reštart servera zachová stavy', async () => {
  const n = count('SELECT COUNT(*) AS n FROM payments');
  const done = count("SELECT COUNT(*) AS n FROM tickets WHERE status = 'done'");
  assert.ok(done > n, 'ukončené návštevy bez platby ostávajú bez platby');
  assert.equal(count("SELECT COUNT(*) AS n FROM payments p WHERE NOT EXISTS (SELECT 1 FROM payment_events e WHERE e.payment_id = p.id AND e.type = 'confirmed')"), 0, 'každá platba má potvrdenie sestry');
  const { open } = require('../src/db');
  const db2 = open(':memory:');
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM payments').get().n, 0);
  assert.equal(db2.prepare('PRAGMA user_version').get().user_version, 3);
  db2.close();
});
