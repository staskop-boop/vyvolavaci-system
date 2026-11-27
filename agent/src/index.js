#!/usr/bin/env node
'use strict';
/**
 * Lokálny agent AdNa pre VRP2.
 *   node src/index.js spustit      [--konfiguracia <súbor>]   beh na pozadí (spúšťa sa automaticky po prihlásení do Windows)
 *   node src/index.js prihlasenie  [--konfiguracia <súbor>]   prvé / výnimočné prihlásenie do VRP2 (poverená osoba, viditeľné okno)
 *   node src/index.js kontrola     [--konfiguracia <súbor>]   spojenie so serverom, relácia VRP2, aktívna pokladnica, tlačiareň
 * Konfigurácia: --konfiguracia, premenná ADNA_VRP2_AGENT_CONFIG, inak %ProgramData%\AdNa\vrp2-agent\konfiguracia.json.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Agent, serverApi } = require('./agent');
const { Journal } = require('./journal');
const { Printer } = require('./tlac');
const { Vrp2Simulator, SimDriver } = require('./drivers/simulator');
const { Vrp2WebDriver } = require('./drivers/vrp2-web');
const VERSION = require('../package.json').version;

function args() {
  const a = process.argv.slice(2);
  const i = a.indexOf('--konfiguracia');
  return { cmd: a[0] || 'spustit', file: i >= 0 ? a[i + 1] : process.env.ADNA_VRP2_AGENT_CONFIG || path.join(process.env.ProgramData || '/etc', 'AdNa', 'vrp2-agent', 'konfiguracia.json') };
}

function logger(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return (level, msg, meta) => {
    // do logu nikdy token, heslo ani cookies – len správa a technické údaje
    const line = JSON.stringify({ at: new Date().toISOString(), level, msg, ...(meta || {}) });
    try { fs.appendFileSync(path.join(dir, `agent-${new Date().toISOString().slice(0, 10)}.log`), line + '\n'); } catch {}
    if (level !== 'debug') console.log(line);
  };
}

function build(cfg) {
  if (!cfg.server || !cfg.token) throw new Error('V konfigurácii chýba „server“ alebo „token“.');
  const dataDir = cfg.data || path.join(path.dirname(args().file), 'data');
  let driver;
  if (cfg.rezim === 'live') {
    if (cfg.ostryRezimPovoleny !== true) throw new Error('Ostrý režim nie je v konfigurácii povolený („ostryRezimPovoleny“: true).');
    driver = new Vrp2WebDriver({ url: cfg.vrp2 && cfg.vrp2.url, profil: cfg.vrp2.profil, ovladanie: cfg.vrp2.ovladanie, headless: cfg.vrp2.headless !== false });
    if (!driver.verified()) throw new Error('Ovládanie VRP2 (vrp2-ovladanie.json) nie je overené – ostrý režim sa nespustí.');
  } else {
    const s = cfg.simulator || {};
    const sim = new Vrp2Simulator(path.join(dataDir, 'simulator-vrp2.json'), { registers: s.pokladnice || [], activeCode: s.aktivna || null, catalog: s.katalog || {} });
    driver = new SimDriver(sim);
  }
  const log = logger(path.join(dataDir, 'logy'));
  const agent = new Agent({ api: serverApi(cfg.server, cfg.token), driver, printer: new Printer(cfg.tlac || {}), journal: new Journal(path.join(dataDir, 'dennik')), name: cfg.nazov || 'agent', log, version: VERSION });
  return { agent, driver, log };
}

async function main() {
  const { cmd, file } = args();
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (cmd === 'prihlasenie') {
    if (cfg.rezim !== 'live') { console.log('Agent je v režime simulátora – prihlásenie do VRP2 nie je potrebné.'); return; }
    await Vrp2WebDriver.interactiveLogin({ url: cfg.vrp2.url, profil: cfg.vrp2.profil });
    console.log('Hotovo. Spustite „kontrola“.');
    return;
  }
  const { agent, driver, log } = build(cfg);
  if (cmd === 'kontrola') {
    const hb = await agent.heartbeat();
    console.log(`Server: OK · režim agenta: ${driver.mode === 'live' ? 'OSTRÝ' : 'SIMULÁTOR'} · relácia VRP2: ${agent.session}`);
    try { const a = await driver.activeRegister(); console.log(`Aktívna pokladnica vo VRP2: ${a.code || '?'} · ${a.companyName || ''} ${a.companyIco ? 'IČO ' + a.companyIco : ''}`); } catch (e) { console.log('Aktívna pokladnica: ' + e.message); }
    for (const g of hb.registers) console.log(`Pridelená pokladnica: ${g.label} · ${g.companyName} · kód ${g.vrpCode || '—'} · režim ${g.mode} · tlačiareň ${g.printerName || '—'}`);
    console.log(`Tlačiareň: ${agent.printerState.ok ? 'OK' : '⚠ ' + agent.printerState.message}`);
    await driver.close?.();
    return;
  }
  log('info', 'Agent VRP2 sa spúšťa', { mode: driver.mode, version: VERSION });
  const stop = async () => { agent.stop(); await driver.close?.(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  await agent.loop();
}

if (require.main === module) main().catch((e) => { console.error('⚠ ' + e.message); process.exit(1); });
module.exports = { build };
