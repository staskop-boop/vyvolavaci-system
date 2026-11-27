'use strict';
/**
 * 2026-11-27 (Pali): platba pacienta pri ukončení návštevy a pokladničný doklad vo VRP2 Finančnej správy SR.
 *
 * Tok: sestra v aplikácii Sestra potvrdí platbu → jedna transakcia (ukončenie návštevy + nemenná kópia platby + trvalá úloha)
 * → lokálny agent na PC recepcie si úlohu prevezme, vo VRP2 pripraví doklad, porovná ho s potvrdenou platbou, vystaví ho
 * a pošle originálny tlačový výstup na tlačiareň → výsledok vráti sem.
 *
 * Stavy sa vedú oddelene: návšteva (tickets.status), platba (payment_status), doklad (receipt_status), tlač (print_jobs).
 * Ochrana pred dvomi dokladmi: op_id UNIQUE, ticket_id UNIQUE, stav 'submitting' zapísaný pred konečným odoslaním do VRP2
 * a databázové spúšťače (db.js), ktoré po začatom odoslaní nedovolia úlohu potichu vrátiť do fronty.
 * Agent nikdy nedostane meno pacienta, identifikátor od sestry, typ pacienta ani číslo z poradia.
 */
const crypto = require('node:crypto');
const { tx } = require('./db');
const clock = require('./clock');
const log = require('./log');
const money = require('../../shared/peniaze.js');

class BillingError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const bad = (m) => new BillingError(400, 'BAD_REQUEST', m);
const conflict = (m) => new BillingError(409, 'CONFLICT', m);
const notFound = (m = 'Záznam neexistuje.') => new BillingError(404, 'NOT_FOUND', m);
const forbidden = (m) => new BillingError(403, 'FORBIDDEN', m);

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const AGENT_ONLINE_MS = 30_000;   // agent posiela stav každých ~5 s; 30 s bez správy = nedostupný
const CLAIM_EXPIRE_MS = 120_000;  // prevzatá, ale neodoslaná úloha sa po 2 min. vráti do fronty (do VRP2 ešte nič neodišlo)
const VARIANTS = { '': '', one: 'jedna končatina', both: 'obe končatiny' };
const OP_ID = /^[A-Za-z0-9-]{16,64}$/;

function txt(v, max, name, { allowEmpty = false } = {}) {
  if (v == null) v = '';
  if (typeof v !== 'string' && typeof v !== 'number') throw bad(`Hodnota „${name}“ musí byť text.`);
  const s = String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!allowEmpty && !s) throw bad(`Hodnota „${name}“ nesmie byť prázdna.`);
  if (s.length > max) throw bad(`Hodnota „${name}“ je príliš dlhá (max. ${max} znakov).`);
  return s;
}
const intId = (v, name) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw bad(`Neplatné ${name}.`); return n; };
const json = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

/** Texty stavov pre sestru (zadanie Pali, bod 7). */
const RECEIPT_TEXT = {
  queued: 'Platba prijatá · pripravuje sa doklad.',
  queued_offline: 'Platba prijatá · čaká na agenta.',
  claimed: 'Platba prijatá · pripravuje sa doklad.',
  submitting: 'Platba prijatá · pripravuje sa doklad.',
  needs_session: 'Platba prijatá · treba obnoviť prihlásenie do VRP2.',
  unverified: 'Platba prijatá · vydanie dokladu treba overiť.',
  mismatch: 'Platba prijatá · doklad nevydaný – údaje vo VRP2 nesedia, rieši správca.',
  failed: 'Platba prijatá · doklad nevydaný – rieši správca.',
};

class Billing {
  constructor(db, store) {
    this.db = db;
    this.store = store;
    this.seed();
  }

  /** Obe spoločnosti zo zadania (len názvy – IČO, pokladnice a cenník nastaví správca). */
  seed() {
    if (this.db.prepare("SELECT 1 FROM settings WHERE key = 'billingSeeded'").get()) return;
    tx(this.db, () => {
      for (const n of ['AdNa s.r.o.', 'Ultrazvukové pracovisko s.r.o.']) this.db.prepare('INSERT OR IGNORE INTO billing_companies (name) VALUES (?)').run(n);
      this.db.prepare("INSERT INTO settings (key, value) VALUES ('billingSeeded', 'true')").run();
    });
  }

  changed() { this.store.changed('payments'); }

  // ---------- zapnutie funkcie ----------
  config() {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = 'billingConfig'").get();
    return { enabled: false, ...json(r && r.value, {}) };
  }
  setConfig(b, user) {
    const c = this.config();
    if (b && 'enabled' in b) c.enabled = !!b.enabled;
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('billingConfig', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(c));
    this.event(null, 'config', null, null, user, null, c.enabled ? 'platby zapnuté' : 'platby vypnuté');
    this.changed();
    return c;
  }

  event(paymentId, type, from, to, user, agentId, note) {
    this.db.prepare('INSERT INTO payment_events (payment_id, at, type, from_status, to_status, user_id, user_name, agent_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(paymentId ?? null, clock.nowIso(), type, from ?? null, to ?? null, user ? user.id : null, user ? (user.nurseName || user.username) : null, agentId ?? null, note ? String(note).slice(0, 500) : null);
  }

  // ---------- nastavenia (správca) ----------
  companies() { return this.db.prepare('SELECT id, name, ico, active FROM billing_companies ORDER BY id').all().map((c) => ({ ...c, active: !!c.active })); }
  saveCompany(id, b) {
    const name = txt(b && b.name, 80, 'Názov spoločnosti');
    const ico = txt(b && b.ico, 12, 'IČO', { allowEmpty: true });
    if (ico && !/^\d{6,10}$/.test(ico)) throw bad('IČO môže obsahovať len číslice.');
    const active = b && 'active' in b ? (b.active ? 1 : 0) : 1;
    try {
      if (id) { if (!this.db.prepare('UPDATE billing_companies SET name = ?, ico = ?, active = ? WHERE id = ?').run(name, ico, active, id).changes) throw notFound(); }
      else id = Number(this.db.prepare('INSERT INTO billing_companies (name, ico, active) VALUES (?, ?, ?)').run(name, ico, active).lastInsertRowid);
    } catch (e) { if (/UNIQUE/.test(e.message)) throw conflict('Spoločnosť s týmto názvom už existuje.'); throw e; }
    this.changed();
    return this.companies().find((c) => c.id === id);
  }

  agentHealth(a) {
    if (!a) return { online: false, status: null };
    const st = json(a.status_json, null);
    const online = !!a.last_seen_at && Date.now() - Date.parse(a.last_seen_at) < AGENT_ONLINE_MS;
    return { online, lastSeenAt: a.last_seen_at, status: st };
  }
  agents() {
    return this.db.prepare('SELECT * FROM vrp_agents ORDER BY id').all().map((a) => ({ id: a.id, name: a.name, active: !!a.active, createdAt: a.created_at, ...this.agentHealth(a) }));
  }
  /** Token sa ukáže iba raz – v databáze je len jeho odtlačok (SHA-256). */
  createAgent(b, user) {
    const name = txt(b && b.name, 60, 'Názov agenta');
    const token = 'vrpa_' + crypto.randomBytes(32).toString('base64url');
    const id = Number(this.db.prepare('INSERT INTO vrp_agents (name, token_hash, created_at) VALUES (?, ?, ?)').run(name, sha(token), clock.nowIso()).lastInsertRowid);
    this.event(null, 'agent_created', null, null, user, id, name);
    this.changed();
    return { agent: this.agents().find((a) => a.id === id), token };
  }
  updateAgent(id, b, user) {
    const a = this.db.prepare('SELECT * FROM vrp_agents WHERE id = ?').get(id);
    if (!a) throw notFound('Agent neexistuje.');
    const name = b && 'name' in b ? txt(b.name, 60, 'Názov agenta') : a.name;
    const active = b && 'active' in b ? (b.active ? 1 : 0) : a.active;
    let token = null;
    if (b && b.newToken) token = 'vrpa_' + crypto.randomBytes(32).toString('base64url');
    this.db.prepare('UPDATE vrp_agents SET name = ?, active = ?, token_hash = ? WHERE id = ?').run(name, active, token ? sha(token) : a.token_hash, id);
    this.event(null, token ? 'agent_token' : 'agent_updated', null, null, user, id, name);
    this.changed();
    return { agent: this.agents().find((x) => x.id === id), token };
  }

  registerRows() {
    return this.db.prepare(`SELECT g.*, c.name AS company_name, c.ico AS company_ico, a.name AS agent_name, a.last_seen_at AS agent_seen, a.status_json AS agent_status, a.active AS agent_active
      FROM cash_registers g JOIN billing_companies c ON c.id = g.company_id LEFT JOIN vrp_agents a ON a.id = g.agent_id ORDER BY g.id`).all();
  }
  registerOut(g) {
    const rooms = this.db.prepare('SELECT room_id FROM room_registers WHERE register_id = ?').all(g.id).map((r) => r.room_id);
    const agent = g.agent_id ? { id: g.agent_id, name: g.agent_name, active: !!g.agent_active, ...this.agentHealth({ last_seen_at: g.agent_seen, status_json: g.agent_status }) } : null;
    return { id: g.id, companyId: g.company_id, companyName: g.company_name, companyIco: g.company_ico, label: g.label, vrpCode: g.vrp_code, mode: g.mode,
      agentId: g.agent_id ?? null, agent, printerName: g.printer_name, active: !!g.active, liveSince: g.live_since, roomIds: rooms };
  }
  registers() { return this.registerRows().map((g) => this.registerOut(g)); }
  getRegister(id) { return this.registers().find((r) => r.id === Number(id)) || null; }

  saveRegister(id, b, user) {
    const companyId = intId(b && b.companyId, 'spoločnosť');
    if (!this.db.prepare('SELECT 1 FROM billing_companies WHERE id = ?').get(companyId)) throw bad('Vyberte spoločnosť.');
    const label = txt(b.label, 60, 'Názov pokladnice');
    const code = txt(b.vrpCode, 30, 'Kód pokladnice', { allowEmpty: true });
    if (code && !/^\d{10,25}$/.test(code)) throw bad('Kód pokladnice VRP2 obsahuje len číslice (napr. 17 číslic z exportu VRP2).');
    const agentId = b.agentId == null || b.agentId === '' ? null : intId(b.agentId, 'agent');
    if (agentId && !this.db.prepare('SELECT 1 FROM vrp_agents WHERE id = ?').get(agentId)) throw bad('Agent neexistuje.');
    const printer = txt(b.printerName, 120, 'Tlačiareň', { allowEmpty: true });
    const active = 'active' in b ? (b.active ? 1 : 0) : 1;
    const roomIds = Array.isArray(b.roomIds) ? [...new Set(b.roomIds.map((r) => intId(r, 'pracovisko')))] : null;
    const rid = tx(this.db, () => {
      let rid = id;
      if (id) {
        const cur = this.db.prepare('SELECT * FROM cash_registers WHERE id = ?').get(id);
        if (!cur) throw notFound('Pokladnica neexistuje.');
        // ostrá pokladnica: zmena kódu alebo spoločnosti by zmenila, kam idú doklady – najprv ju treba vrátiť do skúšobného režimu
        if (cur.mode === 'live' && (cur.vrp_code !== code || cur.company_id !== companyId)) throw conflict('Ostrej pokladnici nemožno zmeniť spoločnosť ani kód. Najprv ju prepnite do skúšobného režimu.');
        this.db.prepare('UPDATE cash_registers SET company_id = ?, label = ?, vrp_code = ?, agent_id = ?, printer_name = ?, active = ? WHERE id = ?').run(companyId, label, code, agentId, printer, active, id);
      } else {
        rid = Number(this.db.prepare('INSERT INTO cash_registers (company_id, label, vrp_code, agent_id, printer_name, active) VALUES (?, ?, ?, ?, ?, ?)').run(companyId, label, code, agentId, printer, active).lastInsertRowid);
      }
      if (roomIds) {
        for (const r of roomIds) if (!this.db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(r)) throw bad('Pracovisko neexistuje.');
        this.db.prepare('DELETE FROM room_registers WHERE register_id = ?').run(rid);
        for (const r of roomIds) this.db.prepare('INSERT INTO room_registers (room_id, register_id) VALUES (?, ?)').run(r, rid);
      }
      return rid;
    });
    this.event(null, id ? 'register_updated' : 'register_created', null, null, user, agentId, `${label} (${code || 'bez kódu'})`);
    this.changed();
    return this.getRegister(rid);
  }

  /**
   * Prepnutie do ostrého režimu je vedomý krok správcu (napísať OSTRÁ). Nasadenie novej verzie ho nikdy neurobí samo.
   * Podmienky: kód pokladnice, IČO spoločnosti, priradený agent.
   */
  setRegisterMode(id, mode, confirm, user) {
    const g = this.getRegister(id);
    if (!g) throw notFound('Pokladnica neexistuje.');
    if (!['sim', 'live'].includes(mode)) throw bad('Neznámy režim.');
    if (mode === 'live') {
      if (confirm !== 'OSTRÁ') throw bad('Ostrý režim potvrďte napísaním slova OSTRÁ.');
      if (!g.vrpCode) throw bad('Ostrá pokladnica musí mať kód pokladnice VRP2.');
      if (!g.companyIco) throw bad('Spoločnosť ostrej pokladnice musí mať vyplnené IČO.');
      if (!g.agentId) throw bad('Ostrá pokladnica musí mať priradeného agenta.');
    }
    const busy = this.db.prepare("SELECT 1 FROM payments WHERE register_id = ? AND receipt_status IN ('claimed','submitting') LIMIT 1").get(g.id);
    if (busy) throw conflict('Pokladnica práve spracúva doklad. Skúste to o chvíľu.');
    this.db.prepare('UPDATE cash_registers SET mode = ?, live_since = ?, live_by = ? WHERE id = ?').run(mode, mode === 'live' ? clock.nowIso() : null, mode === 'live' ? user.id : null, g.id);
    this.event(null, 'register_mode', g.mode, mode, user, g.agentId, g.label);
    log.info('Režim pokladnice VRP2 zmenený', { register: g.id, mode, userId: user.id });
    this.changed();
    return this.getRegister(g.id);
  }

  priceItems() {
    return this.db.prepare('SELECT p.*, c.name AS company_name FROM price_items p JOIN billing_companies c ON c.id = p.company_id ORDER BY c.id, p.vrp_name').all()
      .map((p) => ({ id: p.id, companyId: p.company_id, companyName: p.company_name, name: p.vrp_name, code: p.vrp_code, priceCents: p.price_cents, active: !!p.active, updatedAt: p.updated_at }));
  }
  savePriceItem(id, b, user) {
    const companyId = intId(b && b.companyId, 'spoločnosť');
    const name = txt(b.name, 255, 'Označenie položky (presne ako vo VRP2)');
    const code = txt(b.code, 40, 'Kód tovaru', { allowEmpty: true });
    const price = b.priceCents == null || b.priceCents === '' ? null : Number(b.priceCents);
    if (price != null && !money.isCents(price)) throw bad('Cena musí byť v centoch, 0 až 10 000 000.');
    const active = 'active' in b ? (b.active ? 1 : 0) : 1;
    try {
      if (id) { if (!this.db.prepare('UPDATE price_items SET company_id = ?, vrp_name = ?, vrp_code = ?, price_cents = ?, active = ?, updated_at = ? WHERE id = ?').run(companyId, name, code, price, active, clock.nowIso(), id).changes) throw notFound(); }
      else id = Number(this.db.prepare('INSERT INTO price_items (company_id, vrp_name, vrp_code, price_cents, active, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(companyId, name, code, price, active, clock.nowIso()).lastInsertRowid);
    } catch (e) { if (/UNIQUE/.test(e.message)) throw conflict('Položka s týmto názvom už v cenníku spoločnosti je.'); throw e; }
    this.event(null, 'price_item', null, null, user, null, `${name}: ${price == null ? 'bez ceny' : money.fmtEur(price)}`);
    this.changed();
    return this.priceItems().find((p) => p.id === id);
  }

  /**
   * Import cenníka z exportu VRP2 „Tovary a služby“ (xlsx otvorený v Exceli → označiť riadky → Ctrl+C → vložiť sem).
   * Stĺpce: Označenie tovaru/služby, EAN, Kód tovaru, Cena s DPH, Cena bez DPH, Platnosť od, Platnosť do.
   * Riadok s vyplnenou „Platnosť do“ (už neplatná položka) sa preskočí. Existujúca položka sa aktualizuje podľa názvu.
   */
  importPriceItems(companyId, text, user) {
    companyId = intId(companyId, 'spoločnosť');
    if (!this.db.prepare('SELECT 1 FROM billing_companies WHERE id = ?').get(companyId)) throw bad('Vyberte spoločnosť.');
    if (typeof text !== 'string' || text.length > 500_000) throw bad('Vložte riadky z exportu VRP2.');
    const rows = text.split(/\r?\n/).map((l) => l.split('\t')).filter((c) => c.length >= 4 && c[0].trim());
    let added = 0, updated = 0, skipped = 0;
    const errors = [];
    tx(this.db, () => {
      for (const c of rows) {
        const name = c[0].trim().replace(/\s+/g, ' ');
        if (/^Označenie tovaru/i.test(name) || name === 'Report') { skipped++; continue; }
        if ((c[6] || '').trim()) { skipped++; continue; }
        const raw = (c[3] || '').trim();
        const price = raw === '' ? null : money.parseEur(raw);
        if (raw !== '' && price == null) { errors.push(`${name}: neplatná cena „${raw}“`); continue; }
        if (name.length > 255) { errors.push(`${name.slice(0, 40)}…: príliš dlhý názov`); continue; }
        const ex = this.db.prepare('SELECT id FROM price_items WHERE company_id = ? AND vrp_name = ?').get(companyId, name);
        if (ex) { this.db.prepare('UPDATE price_items SET vrp_code = ?, price_cents = ?, active = 1, updated_at = ? WHERE id = ?').run((c[2] || '').trim(), price, clock.nowIso(), ex.id); updated++; }
        else { this.db.prepare('INSERT INTO price_items (company_id, vrp_name, vrp_code, price_cents, updated_at) VALUES (?, ?, ?, ?, ?)').run(companyId, name, (c[2] || '').trim(), price, clock.nowIso()); added++; }
      }
    });
    this.event(null, 'price_import', null, null, user, null, `pridané ${added}, aktualizované ${updated}, preskočené ${skipped}, chyby ${errors.length}`);
    this.changed();
    return { added, updated, skipped, errors };
  }

  procedures() {
    const items = this.db.prepare(`SELECT pi.*, p.vrp_name, p.price_cents, p.active AS item_active, p.company_id, c.name AS company_name FROM procedure_items pi
      JOIN price_items p ON p.id = pi.price_item_id JOIN billing_companies c ON c.id = p.company_id ORDER BY pi.id`).all();
    return this.db.prepare('SELECT * FROM procedures ORDER BY sort_order, name').all().map((pr) => ({
      id: pr.id, name: pr.name, sortOrder: pr.sort_order, active: !!pr.active,
      items: items.filter((i) => i.procedure_id === pr.id).map((i) => ({ variant: i.variant, variantText: VARIANTS[i.variant], priceItemId: i.price_item_id,
        itemName: i.vrp_name, priceCents: i.price_cents, itemActive: !!i.item_active, companyId: i.company_id, companyName: i.company_name, qty: i.qty })),
    }));
  }
  /** Výkon AdNa → položka VRP2. items: [{ variant: ''|'one'|'both', priceItemId, qty }] (buď jedna bez variantu, alebo jedna/obe končatiny). */
  saveProcedure(id, b, user) {
    const name = txt(b && b.name, 80, 'Názov výkonu');
    const sort = b.sortOrder == null ? 0 : Number(b.sortOrder);
    if (!Number.isInteger(sort) || sort < 0 || sort > 999) throw bad('Poradie musí byť 0 – 999.');
    const active = 'active' in b ? (b.active ? 1 : 0) : 1;
    const items = Array.isArray(b.items) ? b.items : [];
    const variants = items.map((i) => String(i.variant || ''));
    if (new Set(variants).size !== variants.length || !variants.every((v) => v in VARIANTS)) throw bad('Každý variant výkonu môže mať najviac jednu položku.');
    if (variants.includes('') && variants.length > 1) throw bad('Výkon má buď jednu položku, alebo samostatné položky pre jednu a obe končatiny.');
    const pid = tx(this.db, () => {
      let pid = id;
      try {
        if (id) { if (!this.db.prepare('UPDATE procedures SET name = ?, sort_order = ?, active = ? WHERE id = ?').run(name, sort, active, id).changes) throw notFound('Výkon neexistuje.'); }
        else pid = Number(this.db.prepare('INSERT INTO procedures (name, sort_order, active) VALUES (?, ?, ?)').run(name, sort, active).lastInsertRowid);
      } catch (e) { if (/UNIQUE/.test(e.message)) throw conflict('Výkon s týmto názvom už existuje.'); throw e; }
      this.db.prepare('DELETE FROM procedure_items WHERE procedure_id = ?').run(pid);
      let company = null;
      for (const i of items) {
        const pi = this.db.prepare('SELECT * FROM price_items WHERE id = ?').get(intId(i.priceItemId, 'položka cenníka'));
        if (!pi) throw bad('Položka cenníka neexistuje.');
        if (company != null && company !== pi.company_id) throw bad('Všetky položky výkonu musia patriť tej istej spoločnosti.');
        company = pi.company_id;
        const qty = i.qty == null ? 1 : Number(i.qty);
        if (!Number.isInteger(qty) || qty < 1 || qty > 9999) throw bad('Množstvo musí byť celé číslo 1 – 9999.');
        this.db.prepare('INSERT INTO procedure_items (procedure_id, variant, price_item_id, qty) VALUES (?, ?, ?, ?)').run(pid, String(i.variant || ''), pi.id, qty);
      }
      return pid;
    });
    this.event(null, 'procedure', null, null, user, null, name);
    this.changed();
    return this.procedures().find((p) => p.id === pid);
  }
  deleteProcedure(id, user) {
    const p = this.db.prepare('SELECT * FROM procedures WHERE id = ?').get(id);
    if (!p) throw notFound('Výkon neexistuje.');
    this.db.prepare('DELETE FROM procedures WHERE id = ?').run(id);
    this.event(null, 'procedure_deleted', null, null, user, null, p.name);
    this.changed();
    return { deleted: true };
  }

  adminState() {
    return { config: this.config(), companies: this.companies(), registers: this.registers(), agents: this.agents(), priceItems: this.priceItems(), procedures: this.procedures() };
  }

  // ---------- formulár „Ukončiť pacienta“ ----------
  /** Upozornenia pre sestru ešte pred prijatím platby. block = platbu nemožno prijať. */
  registerWarnings(g) {
    const w = [];
    if (!g.active) w.push({ block: true, text: 'Pokladnica je vypnutá.' });
    if (!g.agentId || !g.agent) w.push({ block: true, text: 'Pokladnica nemá priradeného agenta VRP2 – nastaví správca.' });
    else if (!g.agent.active) w.push({ block: true, text: 'Agent pokladnice je vypnutý – nastaví správca.' });
    if (g.mode === 'live' && !g.vrpCode) w.push({ block: true, text: 'Chýba kód pokladnice VRP2.' });
    if (g.agent && g.agent.active) {
      const st = g.agent.status || {};
      if (!g.agent.online) w.push({ block: false, text: 'Agent VRP2 na recepcii nie je pripojený – doklad sa vystaví, keď sa pripojí.' });
      else {
        if (st.mode && st.mode !== g.mode) w.push({ block: false, text: `Agent beží v režime „${st.mode === 'live' ? 'ostrý' : 'simulátor'}“, pokladnica je nastavená na „${g.mode === 'live' ? 'ostrý' : 'simulátor'}“ – doklad počká, kým to správca zosúladí.` });
        if (st.session === 'login_required') w.push({ block: false, text: 'Treba obnoviť prihlásenie do VRP2 (poverená osoba) – doklad sa vystaví po prihlásení.' });
        if (st.printer && st.printer.ok === false) w.push({ block: false, text: `Tlačiareň hlási problém: ${String(st.printer.message || 'neznámy').slice(0, 120)}` });
      }
    }
    return w;
  }

  formInfo(ticketId, user) {
    const t = this.store.getTicket(ticketId);
    if (!t) throw notFound('Číslo neexistuje.');
    const cfg = this.config();
    const existing = this.db.prepare('SELECT * FROM payments WHERE ticket_id = ?').get(t.id);
    const roomId = t.roomId ?? t.homeRoomId ?? user.roomId ?? null;
    const regs = this.registers().filter((g) => g.active && (roomId == null ? false : g.roomIds.includes(roomId)));
    const procs = this.procedures().filter((p) => p.active);
    const items = this.priceItems().filter((p) => p.active);
    return {
      enabled: cfg.enabled, ticket: { id: t.id, code: t.code, status: t.status, roomId, roomName: roomId ? (this.store.getRoom(roomId) || {}).name || '' : '' },
      payment: existing ? this.paymentOut(existing) : null,
      registers: regs.map((g) => ({ id: g.id, label: g.label, mode: g.mode, companyId: g.companyId, companyName: g.companyName, vrpCode: g.vrpCode, warnings: this.registerWarnings(g) })),
      procedures: procs.map((p) => ({ id: p.id, name: p.name, items: p.items.filter((i) => i.itemActive) })),
      priceItems: items.map((p) => ({ id: p.id, companyId: p.companyId, name: p.name, priceCents: p.priceCents })),
      roomNote: roomId == null ? 'Pacient nemá priradené pracovisko.' : regs.length ? null : 'Pracovisko nemá priradenú pokladnicu VRP2 – nastaví správca.',
    };
  }

  /** Riadky od sestry → nemenné položky dokladu podľa aktuálneho cenníka. Chýbajúca cena alebo mapovanie = chyba pred platbou. */
  resolveLines(lines, companyId) {
    if (!Array.isArray(lines) || !lines.length) throw bad('Vyberte aspoň jeden výkon, ktorý pacient hradí.');
    if (lines.length > 30) throw bad('Doklad môže mať najviac 30 položiek.');
    return lines.map((l) => {
      let pi, procName = null, variant = '';
      const qty = Number(l && l.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 9999) throw bad('Množstvo musí byť celé číslo 1 – 9999.');
      if (l.procedureId != null) {
        const pr = this.db.prepare('SELECT * FROM procedures WHERE id = ? AND active = 1').get(Number(l.procedureId));
        if (!pr) throw bad('Výkon neexistuje alebo je vypnutý.');
        variant = String(l.variant || '');
        const maps = this.db.prepare('SELECT * FROM procedure_items WHERE procedure_id = ?').all(pr.id);
        if (!maps.length) throw bad(`Výkon „${pr.name}“ nemá priradenú položku VRP2 – doplní správca v Nastaveniach.`);
        const m = maps.find((x) => x.variant === variant);
        if (!m) throw bad(maps.some((x) => x.variant) ? `Pri výkone „${pr.name}“ vyberte jednu alebo obe končatiny.` : `Výkon „${pr.name}“ nemá variant „${VARIANTS[variant] || variant}“.`);
        pi = this.db.prepare('SELECT * FROM price_items WHERE id = ?').get(m.price_item_id);
        procName = pr.name;
      } else {
        pi = this.db.prepare('SELECT * FROM price_items WHERE id = ?').get(Number(l && l.priceItemId));
        if (!pi) throw bad('Položka cenníka neexistuje.');
      }
      if (!pi.active) throw bad(`Položka „${pi.vrp_name}“ je v cenníku vypnutá.`);
      if (pi.price_cents == null) throw bad(`Položka „${pi.vrp_name}“ nemá v cenníku cenu – doplní správca.`);
      if (pi.company_id !== companyId) throw bad(`Položka „${pi.vrp_name}“ patrí inej spoločnosti ako vybraná pokladnica.`);
      return { priceItemId: pi.id, name: pi.vrp_name, code: pi.vrp_code || '', unitCents: pi.price_cents, qty, totalCents: pi.price_cents * qty, procedure: procName, variant: VARIANTS[variant] || '' };
    });
  }

  /**
   * „Ukončiť pacienta a vytlačiť doklad“ – jedna atómová operácia: ukončenie návštevy + platba + trvalá úloha pre agenta.
   * Rovnaké opId vráti ten istý výsledok (dvojklik, obnovenie stránky, stratená odpoveď).
   */
  finish(ticketId, b, user) {
    if (!this.config().enabled) throw conflict('Platby pacientov nie sú zapnuté – zapne ich správca v Nastaveniach.');
    const opId = String((b && b.opId) || '');
    if (!OP_ID.test(opId)) throw bad('Chýba identifikátor potvrdenia – obnovte formulár.');
    const dup = this.db.prepare('SELECT * FROM payments WHERE op_id = ?').get(opId);
    if (dup) {
      if (dup.ticket_id !== Number(ticketId)) throw conflict('Identifikátor potvrdenia patrí inej návšteve.');
      return { duplicate: true, ticket: this.store.getTicket(dup.ticket_id), payment: this.paymentOut(dup) };
    }
    const g = this.getRegister(intId(b.registerId, 'pokladnica'));
    if (!g || !g.active) throw bad('Vyberte pokladnicu.');
    const block = this.registerWarnings(g).find((w) => w.block);
    if (block) throw conflict(block.text);
    const method = b.method;
    if (!['cash', 'card'].includes(method)) throw bad('Vyberte spôsob úhrady: Hotovosť alebo Karta.');
    if (b.paymentConfirmed !== true) throw bad('Potvrďte, že ste platbu prijali.');
    if (method === 'card' && b.cardApproved !== true) throw bad('Kartovú platbu možno zaevidovať až po potvrdení, že ju terminál schválil.');
    const lines = this.resolveLines(b.lines, g.companyId);
    const received = method === 'cash' ? Number(b.receivedCents) : null;
    if (method === 'cash' && !money.isCents(received)) throw bad('Zadajte prijatú sumu v hotovosti.');
    const sum = money.compute(lines, method, received);
    if (method === 'cash' && !sum.enough) throw bad(`Prijatá suma je nižšia ako suma na úhradu (${money.fmtEur(sum.payableCents)}).`);
    if (Number(b.expectedPayableCents) !== sum.payableCents) throw conflict(`Suma sa medzičasom zmenila (cenník) – na úhradu je ${money.fmtEur(sum.payableCents)}. Skontrolujte položky a potvrďte znova.`);

    const r = tx(this.db, () => {
      const row = this.store.getTicketRow(ticketId);
      this.store.requireToday(row);
      const ex = this.db.prepare('SELECT * FROM payments WHERE ticket_id = ?').get(row.id);
      if (ex) throw conflict(`Návšteva ${row.code} už má zaevidovanú platbu (${money.fmtEur(ex.payable_cents)}).`);
      if (!['waiting', 'called'].includes(row.status)) throw conflict(this.store.conflictMessage(row));
      const roomId = row.room_id ?? row.home_room_id;
      if (roomId == null || !g.roomIds.includes(roomId)) throw conflict('Pokladnica nepatrí pracovisku tejto návštevy.');
      const room = this.store.getRoom(roomId);
      const now = clock.nowIso();
      const u = this.db.prepare("UPDATE tickets SET status = 'done', finished_at = ?, version = version + 1 WHERE id = ? AND status = ?").run(now, row.id, row.status);
      if (u.changes === 0) throw conflict(this.store.conflictMessage(row));
      this.db.prepare("INSERT INTO ticket_events (ticket_id, type, at, room_id, user_id, note) VALUES (?, 'done', ?, ?, ?, 'platba pacienta')").run(row.id, now, row.room_id, user.id);
      const pid = Number(this.db.prepare(`INSERT INTO payments (op_id, ticket_id, ticket_day, ticket_code, company_id, company_name, company_ico, register_id, register_label, register_code, register_mode,
        room_id, room_name, items_json, total_cents, rounding_cents, payable_cents, method, received_cents, change_cents, card_confirmed, confirmed_by, confirmed_by_name, confirmed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        opId, row.id, row.day, row.code, g.companyId, g.companyName, g.companyIco || '', g.id, g.label, g.vrpCode || '', g.mode,
        roomId, room ? room.name : '', JSON.stringify(lines), sum.totalCents, sum.roundingCents, sum.payableCents, method, received, sum.changeCents,
        method === 'card' ? 1 : 0, user.id, user.nurseName || user.username, now).lastInsertRowid);
      this.event(pid, 'confirmed', null, 'queued', user, null, `${method === 'cash' ? 'hotovosť' : 'karta'} ${money.fmtEur(sum.payableCents)}`);
      return pid;
    });
    log.info('Platba pacienta prijatá', { payment: r, register: g.id, mode: g.mode, cents: sum.payableCents, method, userId: user.id });
    this.store.changed('tickets');
    return { duplicate: false, ticket: this.store.getTicket(Number(ticketId)), payment: this.paymentOut(this.getPaymentRow(r)) };
  }

  // ---------- výstup pre aplikáciu ----------
  getPaymentRow(id) { return this.db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(id)); }
  lastPrint(paymentId) { return this.db.prepare('SELECT * FROM print_jobs WHERE payment_id = ? ORDER BY id DESC LIMIT 1').get(paymentId); }

  /** Stav pre sestru – kód, text a dostupná akcia. Simulovaný doklad sa nikdy neukáže ako fiskalizovaný. */
  statusOf(p, pj = this.lastPrint(p.id)) {
    const sim = p.register_mode === 'sim';
    const pre = sim ? 'SIMULÁCIA · ' : '';
    if (p.receipt_status !== 'issued') {
      let key = p.receipt_status;
      if (key === 'queued') {
        const g = this.db.prepare('SELECT a.last_seen_at, a.status_json FROM cash_registers g LEFT JOIN vrp_agents a ON a.id = g.agent_id WHERE g.id = ?').get(p.register_id) || {};
        const h = this.agentHealth(g);
        if (!h.online) key = 'queued_offline';
        else if (h.status && h.status.session === 'login_required') key = 'needs_session';
      }
      return { code: key, text: pre + RECEIPT_TEXT[key], paid: true, issued: false, action: ['unverified', 'mismatch', 'failed'].includes(key) ? 'resolve' : null, attention: key !== 'queued' && key !== 'claimed' && key !== 'submitting' };
    }
    const base = sim ? 'SIMULÁCIA · doklad nie je fiskalizovaný' : 'Doklad vydaný';
    if (!pj) return { code: 'issued', text: `${base} · tlač sa pripravuje.`, paid: true, issued: true, action: 'reprint', attention: false };
    const t = { queued: 'tlač sa pripravuje.', claimed: 'tlač sa pripravuje.', sent: 'odoslané na tlačiareň.', printed: 'vytlačené.', failed: 'chyba tlače.' }[pj.status];
    return { code: 'print_' + pj.status, text: `${base} · ${t}`, paid: true, issued: true, action: 'reprint', attention: pj.status === 'failed' };
  }

  paymentOut(p, { withEvents = false } = {}) {
    if (!p) return null;
    const pj = this.lastPrint(p.id);
    const out = {
      id: p.id, ticketId: p.ticket_id, ticketCode: p.ticket_code, day: p.ticket_day,
      companyName: p.company_name, registerLabel: p.register_label, registerCode: p.register_code, mode: p.register_mode, simulated: p.register_mode === 'sim',
      roomName: p.room_name, items: json(p.items_json, []), totalCents: p.total_cents, roundingCents: p.rounding_cents, payableCents: p.payable_cents,
      method: p.method, receivedCents: p.received_cents, changeCents: p.change_cents,
      confirmedBy: p.confirmed_by_name, confirmedAt: p.confirmed_at,
      receiptStatus: p.receipt_status, attempt: p.attempt, submitStartedAt: p.submit_started_at,
      receipt: p.receipt_id ? { id: p.receipt_id, number: p.receipt_number, issuedAt: p.receipt_issued_at, simulated: !!p.receipt_simulated } : null,
      print: pj ? { id: pj.id, kind: pj.kind, status: pj.status, message: pj.message, at: pj.finished_at || pj.created_at } : null,
      lastError: p.last_error, status: this.statusOf(p, pj),
    };
    if (withEvents) out.events = this.db.prepare('SELECT at, type, from_status AS fromStatus, to_status AS toStatus, user_name AS userName, agent_id AS agentId, note FROM payment_events WHERE payment_id = ? ORDER BY id').all(p.id);
    return out;
  }

  /** Krátky stav pri každej dnešnej návšteve (posiela sa personálu cez WebSocket). */
  staffSummary(day) {
    const byTicket = {};
    for (const p of this.db.prepare('SELECT * FROM payments WHERE ticket_day = ?').all(day)) {
      const o = this.paymentOut(p);
      byTicket[p.ticket_id] = { id: o.id, status: o.status, payableCents: o.payableCents, method: o.method, receiptId: o.receipt && o.receipt.id, simulated: o.simulated, companyName: o.companyName };
    }
    return { enabled: this.config().enabled, payments: byTicket, openCount: this.openList({ roomId: null }).length };
  }

  forDay(day) { return this.db.prepare('SELECT * FROM payments WHERE ticket_day = ? ORDER BY id').all(day).map((p) => this.paymentOut(p, { withEvents: true })); }

  /** „Doklady na doriešenie“ – nevydané doklady a vydané doklady s chybou tlače (sestra vidí svoje pracovisko). */
  openList({ roomId }) {
    const rows = this.db.prepare(`SELECT * FROM payments WHERE (receipt_status <> 'issued'
      OR NOT EXISTS (SELECT 1 FROM print_jobs j WHERE j.payment_id = payments.id AND j.status IN ('sent','printed'))) ORDER BY id DESC LIMIT 200`).all();
    return rows.filter((p) => roomId == null || p.room_id === roomId).map((p) => this.paymentOut(p));
  }

  // ---------- tlač ----------
  /** Opakovaná tlač – vždy existujúci doklad (kópia podľa VRP2), nikdy nové vystavenie. */
  reprint(paymentId, user) {
    const p = this.getPaymentRow(paymentId);
    if (!p) throw notFound('Platba neexistuje.');
    if (user.role !== 'admin' && user.roomId != null && p.room_id !== user.roomId) throw forbidden('Doklad patrí inému pracovisku.');
    if (p.receipt_status !== 'issued') throw conflict('Doklad ešte nebol vydaný – nie je čo tlačiť.');
    const pending = this.db.prepare("SELECT * FROM print_jobs WHERE payment_id = ? AND status IN ('queued','claimed')").get(p.id);
    if (pending) return { payment: this.paymentOut(p), duplicate: true };
    this.db.prepare("INSERT INTO print_jobs (payment_id, register_id, kind, created_at, created_by) VALUES (?, ?, 'copy', ?, ?)").run(p.id, p.register_id, clock.nowIso(), user.id);
    this.event(p.id, 'reprint', null, null, user, null, 'opakovaná tlač (kópia)');
    this.changed();
    return { payment: this.paymentOut(this.getPaymentRow(p.id)), duplicate: false };
  }
  /** Skúšobná tlač – jasne označená testovacia stránka, bez VRP2 a bez tržby. */
  testPrint(registerId, user) {
    const g = this.getRegister(registerId);
    if (!g) throw notFound('Pokladnica neexistuje.');
    if (!g.agentId) throw bad('Pokladnica nemá agenta.');
    const id = Number(this.db.prepare("INSERT INTO print_jobs (payment_id, register_id, kind, created_at, created_by) VALUES (NULL, ?, 'test', ?, ?)").run(g.id, clock.nowIso(), user.id).lastInsertRowid);
    this.event(null, 'test_print', null, null, user, g.agentId, g.label);
    this.changed();
    return { jobId: id };
  }
  printJob(id) {
    const j = this.db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(Number(id));
    return j ? { id: j.id, kind: j.kind, status: j.status, message: j.message, createdAt: j.created_at, finishedAt: j.finished_at } : null;
  }

  // ---------- riešenie výnimiek (poverený správca) ----------
  /**
   * action:
   *  'retry'            – doklad sa do VRP2 ešte neodoslal (nesúlad, chyba pred odoslaním, prihlásenie) → znova do fronty
   *  'confirm-issued'   – správca našiel doklad v evidencii VRP2 a opíše jeho ID → vydaný
   *  'confirm-missing'  – správca overil v evidencii VRP2, že doklad NEBOL vydaný → nový pokus (attempt + 1); treba napísať NEVYDANÝ
   */
  resolve(paymentId, b, user) {
    const p = this.getPaymentRow(paymentId);
    if (!p) throw notFound('Platba neexistuje.');
    const action = b && b.action;
    const note = txt(b && b.note, 300, 'Poznámka', { allowEmpty: true });
    tx(this.db, () => {
      const cur = this.getPaymentRow(p.id);
      if (action === 'retry') {
        if (cur.submit_started_at) throw conflict('Odoslanie do VRP2 sa už začalo – najprv overte doklad v evidencii VRP2 („Doklad je vo VRP2“ / „Doklad vo VRP2 nie je“).');
        if (!['mismatch', 'failed', 'needs_session'].includes(cur.receipt_status)) throw conflict('Úlohu v tomto stave nemožno zopakovať.');
        this.db.prepare("UPDATE payments SET receipt_status = 'queued', claim_token = NULL, claimed_at = NULL, claimed_by_agent = NULL, version = version + 1 WHERE id = ?").run(cur.id);
        this.event(cur.id, 'retry', cur.receipt_status, 'queued', user, null, note || 'znova do fronty');
      } else if (action === 'confirm-issued') {
        if (!['unverified', 'submitting', 'failed', 'mismatch', 'needs_session'].includes(cur.receipt_status)) throw conflict('Doklad v tomto stave nemožno ručne potvrdiť.');
        const rid = txt(b.receiptId, 80, 'ID dokladu z VRP2');
        try {
          this.db.prepare("UPDATE payments SET receipt_status = 'issued', receipt_id = ?, receipt_number = ?, receipt_issued_at = ?, receipt_simulated = ?, claim_token = NULL, last_error = NULL, version = version + 1 WHERE id = ?")
            .run(rid, txt(b.receiptNumber, 40, 'Číslo dokladu', { allowEmpty: true }) || null, clock.nowIso(), cur.register_mode === 'sim' ? 1 : 0, cur.id);
        } catch (e) { if (/UNIQUE/.test(e.message)) throw conflict('Doklad s týmto ID je už priradený inej platbe.'); throw e; }
        this.event(cur.id, 'manual_issued', cur.receipt_status, 'issued', user, null, `ID ${rid}${note ? ' · ' + note : ''}`);
      } else if (action === 'confirm-missing') {
        if (b.confirm !== 'NEVYDANÝ') throw bad('Potvrďte napísaním slova NEVYDANÝ, že ste v evidencii VRP2 overili, že doklad vydaný nebol.');
        if (!['unverified', 'submitting'].includes(cur.receipt_status) || !cur.submit_started_at) throw conflict('Táto možnosť je len pre doklad, ktorého vydanie treba overiť.');
        if (cur.receipt_status === 'submitting' && cur.claimed_at && Date.now() - Date.parse(cur.claimed_at) < CLAIM_EXPIRE_MS) throw conflict('Agent doklad práve odosiela – počkajte na výsledok.');
        this.db.prepare("UPDATE payments SET receipt_status = 'queued', attempt = attempt + 1, submit_started_at = NULL, claim_token = NULL, claimed_at = NULL, claimed_by_agent = NULL, version = version + 1 WHERE id = ?").run(cur.id);
        this.event(cur.id, 'manual_not_issued', cur.receipt_status, 'queued', user, null, `nový pokus ${cur.attempt + 1}${note ? ' · ' + note : ''}`);
      } else throw bad('Neznáma akcia.');
    });
    log.info('Doklad riešený správcom', { payment: p.id, action, userId: user.id });
    this.changed();
    return { payment: this.paymentOut(this.getPaymentRow(p.id), { withEvents: true }) };
  }

  // ---------- rozhranie pre lokálneho agenta ----------
  authAgent(header) {
    const m = /^Bearer\s+(vrpa_[A-Za-z0-9_-]{20,})$/.exec(String(header || ''));
    if (!m) return null;
    const a = this.db.prepare('SELECT * FROM vrp_agents WHERE token_hash = ? AND active = 1').get(sha(m[1]));
    return a || null;
  }

  heartbeat(agent, b) {
    const st = {
      mode: b && b.mode === 'live' ? 'live' : 'sim',
      session: ['ok', 'login_required', 'unknown'].includes(b && b.session) ? b.session : 'unknown',
      activeRegisterCode: b && b.activeRegisterCode ? String(b.activeRegisterCode).slice(0, 30) : null,
      printer: b && b.printer ? { ok: b.printer.ok !== false, message: String(b.printer.message || '').slice(0, 200), name: String(b.printer.name || '').slice(0, 120) } : null,
      version: b && b.version ? String(b.version).slice(0, 20) : null,
      message: b && b.message ? String(b.message).slice(0, 300) : null,
    };
    const prev = json(agent.status_json, {});
    this.db.prepare('UPDATE vrp_agents SET last_seen_at = ?, status_json = ? WHERE id = ?').run(clock.nowIso(), JSON.stringify(st), agent.id);
    if (prev.session !== st.session || prev.mode !== st.mode || (prev.printer && prev.printer.ok) !== (st.printer && st.printer.ok)) this.changed();
    return { ok: true, registers: this.agentRegisters(agent).map((g) => ({ id: g.id, label: g.label, vrpCode: g.vrpCode, mode: g.mode, companyName: g.companyName, companyIco: g.companyIco, printerName: g.printerName })) };
  }
  agentRegisters(agent) { return this.registers().filter((g) => g.agentId === agent.id && g.active); }

  /** Údaje, ktoré agent potrebuje – bez mena pacienta, identifikátora, typu pacienta a čísla z poradia. */
  jobPayload(p) {
    return {
      paymentId: p.id, opId: p.op_id, attempt: p.attempt, claimToken: p.claim_token,
      register: { id: p.register_id, label: p.register_label, vrpCode: p.register_code, mode: p.register_mode },
      company: { name: p.company_name, ico: p.company_ico }, workplace: p.room_name,
      items: json(p.items_json, []).map((i) => ({ name: i.name, code: i.code, unitCents: i.unitCents, qty: i.qty, totalCents: i.totalCents })),
      method: p.method, totalCents: p.total_cents, roundingCents: p.rounding_cents, payableCents: p.payable_cents, receivedCents: p.received_cents, changeCents: p.change_cents,
      confirmedAt: p.confirmed_at, submitStartedAt: p.submit_started_at,
    };
  }

  /**
   * Agent si vypýta ďalšiu prácu. Poradie: 1) vlastná rozpracovaná úloha po reštarte (overenie, nikdy nové vystavenie),
   * 2) tlač, 3) nový doklad – pre jednu pokladnicu vždy najviac jeden rozpracovaný.
   */
  claim(agent, b) {
    const mode = b && b.mode === 'live' ? 'live' : 'sim';
    const session = b && b.session;
    const now = clock.nowIso();
    const job = tx(this.db, () => {
      const old = new Date(Date.now() - CLAIM_EXPIRE_MS).toISOString();
      const exp = this.db.prepare("SELECT id, claimed_by_agent FROM payments WHERE receipt_status = 'claimed' AND submit_started_at IS NULL AND claimed_at < ?").all(old);
      for (const e of exp) {
        this.db.prepare("UPDATE payments SET receipt_status = 'queued', claim_token = NULL, claimed_at = NULL, claimed_by_agent = NULL WHERE id = ?").run(e.id);
        this.event(e.id, 'claim_expired', 'claimed', 'queued', null, e.claimed_by_agent, 'agent neodoslal – späť do fronty');
      }
      this.db.prepare("UPDATE print_jobs SET status = 'queued', claim_token = NULL WHERE status = 'claimed' AND claimed_at < ?").run(old);
      const regs = this.agentRegisters(agent).filter((g) => g.mode === mode);
      if (!regs.length) return null;
      const ids = regs.map((g) => g.id);
      const inList = `(${ids.map(() => '?').join(',')})`;
      // 1) rozpracované týmto agentom – po reštarte agenta
      const mine = this.db.prepare(`SELECT * FROM payments WHERE claimed_by_agent = ? AND receipt_status IN ('claimed','submitting') AND register_id IN ${inList} ORDER BY id LIMIT 1`).get(agent.id, ...ids);
      if (mine) {
        const token = crypto.randomBytes(16).toString('hex');
        this.db.prepare('UPDATE payments SET claim_token = ?, claimed_at = ? WHERE id = ?').run(token, now, mine.id);
        this.event(mine.id, 'reclaimed', mine.receipt_status, mine.receipt_status, null, agent.id, mine.receipt_status === 'submitting' ? 'po reštarte agenta – overenie výsledku' : 'po reštarte agenta');
        return { type: mine.receipt_status === 'submitting' ? 'verify' : 'issue', payment: this.jobPayload({ ...mine, claim_token: token }) };
      }
      // 2) tlač
      const pj = this.db.prepare(`SELECT * FROM print_jobs WHERE status = 'queued' AND register_id IN ${inList} ORDER BY id LIMIT 1`).get(...ids);
      if (pj) {
        const token = crypto.randomBytes(16).toString('hex');
        this.db.prepare("UPDATE print_jobs SET status = 'claimed', claim_token = ?, claimed_at = ? WHERE id = ?").run(token, now, pj.id);
        const p = pj.payment_id ? this.getPaymentRow(pj.payment_id) : null;
        const g = regs.find((x) => x.id === pj.register_id);
        return { type: 'print', print: { jobId: pj.id, kind: pj.kind, claimToken: token, printerName: g.printerName, registerLabel: g.label, companyName: g.companyName },
          payment: p ? { ...this.jobPayload(p), claimToken: undefined, receipt: { id: p.receipt_id, number: p.receipt_number, issuedAt: p.receipt_issued_at, simulated: !!p.receipt_simulated } } : null };
      }
      // 3) nový doklad – len keď agent hlási platné prihlásenie do VRP2 (inak úloha čaká vo fronte, nič sa neodosiela)
      if (session !== 'ok') return null;
      for (const g of regs) {
        if (this.db.prepare("SELECT 1 FROM payments WHERE register_id = ? AND receipt_status IN ('claimed','submitting')").get(g.id)) continue;
        const p = this.db.prepare(`SELECT * FROM payments WHERE register_id = ? AND (receipt_status = 'queued' OR (receipt_status = 'needs_session' AND ? = 'ok' AND submit_started_at IS NULL))
          AND register_mode = ? ORDER BY id LIMIT 1`).get(g.id, session || '', mode);
        if (!p) continue;
        const token = crypto.randomBytes(16).toString('hex');
        this.db.prepare("UPDATE payments SET receipt_status = 'claimed', claim_token = ?, claimed_at = ?, claimed_by_agent = ?, version = version + 1 WHERE id = ?").run(token, now, agent.id, p.id);
        this.event(p.id, 'claimed', p.receipt_status, 'claimed', null, agent.id, null);
        return { type: 'issue', payment: this.jobPayload({ ...p, claim_token: token }) };
      }
      return null;
    });
    if (job) this.changed();
    return { job };
  }

  agentPayment(agent, paymentId, claimToken) {
    const p = this.getPaymentRow(paymentId);
    if (!p) throw notFound('Úloha neexistuje.');
    if (p.claimed_by_agent !== agent.id) throw forbidden('Úlohu spracúva iný agent.');
    if (!claimToken || p.claim_token !== claimToken) throw conflict('Úloha bola medzičasom pridelená znova – tento pokus nepokračuje.');
    return p;
  }

  /** Trvalý záznam „začal sa pokus o vystavenie“ – agent ho musí dostať potvrdený PRED kliknutím na vystavenie vo VRP2. */
  markSubmitting(agent, paymentId, b) {
    const r = tx(this.db, () => {
      const p = this.agentPayment(agent, paymentId, b && b.claimToken);
      if (p.receipt_status !== 'claimed') throw conflict('Úloha nie je pripravená na odoslanie.');
      if (Number(b.attempt) !== p.attempt) throw conflict('Neplatný pokus.');
      this.db.prepare("UPDATE payments SET receipt_status = 'submitting', submit_started_at = ?, version = version + 1 WHERE id = ?").run(clock.nowIso(), p.id);
      this.event(p.id, 'submitting', 'claimed', 'submitting', null, agent.id, `pokus ${p.attempt}`);
      return p.id;
    });
    this.changed();
    return { ok: true, paymentId: r };
  }

  /**
   * Výsledok od agenta. outcome:
   *  issued        – VRP2 potvrdila vydanie (receipt.id povinné; simulated musí sedieť s režimom pokladnice)
   *  mismatch / failed / needs_session – zastavené PRED odoslaním (inak sa z bezpečnosti zapíše ako 'unverified')
   *  unverified    – výsledok odoslania nie je istý → poverená osoba
   */
  reportResult(agent, paymentId, b) {
    const outcome = b && b.outcome;
    const detail = txt(b && b.detail, 500, 'Popis', { allowEmpty: true });
    const r = tx(this.db, () => {
      const p0 = this.getPaymentRow(paymentId);
      if (!p0) throw notFound('Úloha neexistuje.');
      // opakované nahlásenie toho istého vydaného dokladu (stratená odpoveď) je v poriadku
      if (p0.receipt_status === 'issued' && outcome === 'issued' && b.receipt && p0.receipt_id === String(b.receipt.id)) return { id: p0.id, same: true };
      const p = this.agentPayment(agent, paymentId, b && b.claimToken);
      if (outcome === 'issued') {
        if (!p.submit_started_at) throw conflict('Vydanie bez zaznamenaného začiatku odoslania nemožno prijať.');
        if (!['submitting', 'unverified'].includes(p.receipt_status)) throw conflict('Úloha nie je v stave odosielania.');
        const rc = b.receipt || {};
        const rid = txt(rc.id, 80, 'ID dokladu');
        if (!!rc.simulated !== (p.register_mode === 'sim')) throw conflict(p.register_mode === 'sim' ? 'Pokladnica je v skúšobnom režime – agent musí vrátiť simulovaný doklad.' : 'Ostrá pokladnica nemôže prijať simulovaný doklad.');
        if (String(rc.registerCode || '') !== p.register_code && p.register_mode === 'live') throw conflict('Doklad bol vydaný v inej pokladnici, než je v potvrdenej platbe.');
        if (rc.payableCents != null && Number(rc.payableCents) !== p.payable_cents) {
          // doklad už existuje – nesmieme ho zahodiť, ale nesmie sa tváriť ako v poriadku
          this.db.prepare("UPDATE payments SET receipt_status = 'unverified', last_error = ?, version = version + 1 WHERE id = ?").run(`VRP2 vrátila sumu ${money.fmtEur(Number(rc.payableCents))} (ID ${rid}) – potvrdená ${money.fmtEur(p.payable_cents)}`, p.id);
          this.event(p.id, 'amount_mismatch_after_issue', p.receipt_status, 'unverified', null, agent.id, `ID ${rid}`);
          return { id: p.id };
        }
        try {
          this.db.prepare("UPDATE payments SET receipt_status = 'issued', receipt_id = ?, receipt_number = ?, receipt_issued_at = ?, receipt_simulated = ?, claim_token = NULL, last_error = NULL, version = version + 1 WHERE id = ?")
            .run(rid, rc.number ? String(rc.number).slice(0, 40) : null, rc.issuedAt ? String(rc.issuedAt).slice(0, 40) : clock.nowIso(), rc.simulated ? 1 : 0, p.id);
        } catch (e) { if (/UNIQUE/.test(e.message)) throw conflict('Doklad s týmto ID je už priradený inej platbe.'); throw e; }
        this.event(p.id, 'issued', p.receipt_status, 'issued', null, agent.id, `ID ${rid}${rc.simulated ? ' (simulácia)' : ''}${b.verified ? ' · overené po reštarte' : ''}`);
        this.db.prepare("INSERT INTO print_jobs (payment_id, register_id, kind, created_at) VALUES (?, ?, 'original', ?)").run(p.id, p.register_id, clock.nowIso());
        return { id: p.id };
      }
      if (['mismatch', 'failed', 'needs_session'].includes(outcome)) {
        if (p.submit_started_at) {
          this.db.prepare("UPDATE payments SET receipt_status = 'unverified', last_error = ?, version = version + 1 WHERE id = ?").run(`${outcome} po začatí odoslania: ${detail}`, p.id);
          this.event(p.id, 'unverified', p.receipt_status, 'unverified', null, agent.id, `${outcome}: ${detail}`);
          return { id: p.id };
        }
        this.db.prepare('UPDATE payments SET receipt_status = ?, last_error = ?, claim_token = NULL, claimed_at = NULL, claimed_by_agent = NULL, version = version + 1 WHERE id = ?').run(outcome, detail || null, p.id);
        this.event(p.id, outcome, p.receipt_status, outcome, null, agent.id, detail);
        return { id: p.id };
      }
      if (outcome === 'not_submitted') {
        // denník agenta preukazuje, že sa na vystavenie nekliklo (napr. pád medzi potvrdením „submitting“ a kliknutím)
        // → nový pokus (attempt + 1); ak by sa denník nezhodoval, agent posiela 'unverified'
        if (!['submitting', 'claimed'].includes(p.receipt_status)) throw conflict('Úloha nie je rozpracovaná.');
        this.db.prepare("UPDATE payments SET receipt_status = 'queued', attempt = attempt + 1, submit_started_at = NULL, claim_token = NULL, claimed_at = NULL, claimed_by_agent = NULL, version = version + 1 WHERE id = ?").run(p.id);
        this.event(p.id, 'not_submitted', p.receipt_status, 'queued', null, agent.id, detail || 'vystavenie sa nespustilo');
        return { id: p.id };
      }
      if (outcome === 'unverified') {
        this.db.prepare("UPDATE payments SET receipt_status = 'unverified', last_error = ?, version = version + 1 WHERE id = ?").run(detail || 'výsledok odoslania do VRP2 nie je istý', p.id);
        this.event(p.id, 'unverified', p.receipt_status, 'unverified', null, agent.id, detail);
        return { id: p.id };
      }
      throw bad('Neznámy výsledok.');
    });
    this.changed();
    return { payment: this.paymentOut(this.getPaymentRow(r.id)) };
  }

  printResult(agent, jobId, b) {
    const status = b && b.status;
    if (!['sent', 'printed', 'failed'].includes(status)) throw bad('Neznámy stav tlače.');
    tx(this.db, () => {
      const j = this.db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(Number(jobId));
      if (!j) throw notFound('Tlač neexistuje.');
      if (!this.agentRegisters(agent).some((g) => g.id === j.register_id)) throw forbidden('Tlač patrí inému agentovi.');
      if (j.status !== 'claimed' || j.claim_token !== (b && b.claimToken)) {
        if (j.status === status) return;
        throw conflict('Tlač bola medzičasom pridelená znova.');
      }
      this.db.prepare('UPDATE print_jobs SET status = ?, message = ?, finished_at = ?, claim_token = NULL WHERE id = ?').run(status, txt(b.message, 300, 'Správa', { allowEmpty: true }) || null, clock.nowIso(), j.id);
      if (j.payment_id) this.event(j.payment_id, 'print_' + status, null, null, null, agent.id, `${j.kind === 'copy' ? 'kópia' : 'originál'}${b.message ? ': ' + b.message : ''}`);
    });
    this.changed();
    return { print: this.printJob(jobId) };
  }
}

module.exports = { Billing, BillingError, RECEIPT_TEXT, VARIANTS };
