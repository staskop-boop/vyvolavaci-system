'use strict';
/**
 * Tlač bez dialógu na nakonfigurovanej tlačiarni recepcie.
 *  – 'windows': SumatraPDF v tichom režime (-print-to "<tlačiareň>" -silent) – PDF z VRP2 sa odošle do tlačového frontu Windows,
 *  – 'cups':    lp -d <tlačiareň> (Linux / macOS),
 *  – 'subor':   uloží PDF do priečinka (vývoj, testy; s potvrdzuje: true hlási „vytlačené“ – len simulácia).
 * Stav „printed“ (Vytlačené) sa vracia LEN vtedy, keď ho potvrdí rozhranie tlače. Windows/CUPS potvrdia iba prijatie do frontu → „sent“.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const run = (cmd, args, ms = 60_000) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: ms, windowsHide: true }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr || '') })) : resolve(String(stdout || ''))));
});

class Printer {
  /** @param {{typ:'windows'|'cups'|'subor', sumatra?:string, priecinok?:string, potvrdzuje?:boolean, sirkaMm?:number}} cfg */
  constructor(cfg = {}) { this.cfg = { typ: 'subor', sirkaMm: 80, ...cfg }; }

  async check(printerName) {
    const c = this.cfg;
    try {
      if (c.typ === 'subor') { fs.mkdirSync(c.priecinok, { recursive: true }); if (c.chyba) return { ok: false, message: c.chyba, name: printerName }; return { ok: true, message: 'simulovaná tlačiareň (súbor)', name: printerName }; }
      if (!printerName) return { ok: false, message: 'Pokladnica nemá nastavenú tlačiareň.', name: '' };
      if (c.typ === 'windows') {
        if (!c.sumatra || !fs.existsSync(c.sumatra)) return { ok: false, message: 'Chýba SumatraPDF (cesta „sumatra“ v konfigurácii).', name: printerName };
        const out = await run('powershell.exe', ['-NoProfile', '-Command', `Get-Printer -Name '${printerName.replace(/'/g, "''")}' | Select-Object -ExpandProperty PrinterStatus`], 15_000);
        const st = out.trim();
        return { ok: /^(Normal|0)$/i.test(st) || st === '', message: st ? `stav: ${st}` : 'pripravená', name: printerName };
      }
      if (c.typ === 'cups') {
        const out = await run('lpstat', ['-p', printerName], 15_000);
        return { ok: !/disabled|zakázan/i.test(out), message: out.trim().slice(0, 150), name: printerName };
      }
      return { ok: false, message: 'Neznámy typ tlače.', name: printerName };
    } catch (e) { return { ok: false, message: String(e.stderr || e.message).trim().slice(0, 150) || 'tlačiareň nedostupná', name: printerName }; }
  }

  /** @returns {{status:'sent'|'printed', message:string}} – pri chybe vyhodí výnimku */
  async print(pdf, printerName, label) {
    const c = this.cfg;
    if (c.typ === 'subor') {
      if (c.chyba) throw new Error(c.chyba);
      fs.mkdirSync(c.priecinok, { recursive: true });
      const f = path.join(c.priecinok, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.pdf`);
      fs.writeFileSync(f, pdf);
      return c.potvrdzuje ? { status: 'printed', message: `simulovaná tlačiareň potvrdila (${path.basename(f)})` } : { status: 'sent', message: `uložené do ${path.basename(f)}` };
    }
    if (!printerName) throw new Error('Pokladnica nemá nastavenú tlačiareň.');
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adna-tlac-')), `${label}.pdf`);
    fs.writeFileSync(tmp, pdf);
    try {
      if (c.typ === 'windows') {
        // -print-settings "noscale": originálna veľkosť (58/80 mm z VRP2), bez zmenšovania na A4
        await run(c.sumatra, ['-print-to', printerName, '-print-settings', c.nastavenia || 'noscale', '-silent', '-exit-when-done', tmp]);
        return { status: 'sent', message: `odoslané do frontu „${printerName}“` };
      }
      if (c.typ === 'cups') {
        const out = await run('lp', ['-d', printerName, tmp]);
        return { status: 'sent', message: out.trim().slice(0, 150) || `odoslané do frontu „${printerName}“` };
      }
      throw new Error('Neznámy typ tlače.');
    } finally { fs.rm(path.dirname(tmp), { recursive: true, force: true }, () => {}); }
  }
}

module.exports = { Printer };
