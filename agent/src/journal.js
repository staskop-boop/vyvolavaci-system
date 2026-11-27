'use strict';
/**
 * Lokálny denník agenta (JSON riadky, zápis s fsync). Slúži na rozlíšenie po reštarte:
 *  – 'claimed' bez 'clicking' → agent ešte NEKLIKOL na vystavenie (bezpečne nový pokus),
 *  – 'clicking' bez výsledku → VRP2 mohla doklad vydať → overiť / poverená osoba,
 *  – 'issued' → doklad je vydaný, len sa nepodarilo nahlásiť serveru.
 * Denník neobsahuje heslá, tokeny ani údaje o pacientovi – len interné ID platby, pokus a ID dokladu.
 */
const fs = require('node:fs');
const path = require('node:path');

class Journal {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'vystupy'), { recursive: true });
    this.file = path.join(dir, 'dennik.jsonl');
  }

  write(paymentId, attempt, step, data = {}) {
    const line = JSON.stringify({ at: new Date().toISOString(), paymentId, attempt, step, ...data }) + '\n';
    const fd = fs.openSync(this.file, 'a');
    try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  /** Posledné kroky pre platbu a pokus. */
  steps(paymentId, attempt) {
    let txt = '';
    try { txt = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const out = [];
    for (const l of txt.split('\n')) {
      if (!l) continue;
      try { const r = JSON.parse(l); if (r.paymentId === paymentId && r.attempt === attempt) out.push(r); } catch { /* poškodený posledný riadok po výpadku */ }
    }
    return out;
  }

  outputPath(paymentId, ext = 'pdf') { return path.join(this.dir, 'vystupy', `doklad-${Number(paymentId)}.${ext}`); }
  saveOutput(paymentId, output) {
    const p = this.outputPath(paymentId, output.ext || 'pdf');
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, output.data);
    const fd = fs.openSync(tmp, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, p);
    return p;
  }
  loadOutput(paymentId, ext = 'pdf') {
    try { return { ext, data: fs.readFileSync(this.outputPath(paymentId, ext)) }; } catch { return null; }
  }
}

module.exports = { Journal };
