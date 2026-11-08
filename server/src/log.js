'use strict';
// Jednoduché logovanie do súboru s rotáciou. Nezapisujeme heslá, tokeny ani obsah požiadaviek.
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const MAX_BYTES = 2 * 1024 * 1024;
let file = null;

function ensure() {
  if (file) return file;
  fs.mkdirSync(config.logDir, { recursive: true });
  file = path.join(config.logDir, 'server.log');
  return file;
}

function rotate(f) {
  try {
    const st = fs.statSync(f);
    if (st.size > MAX_BYTES) {
      const old = f + '.1';
      try { fs.rmSync(old); } catch {}
      fs.renameSync(f, old);
    }
  } catch {}
}

function write(level, msg, extra) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(extra || {}) });
  if (!config.quiet || level === 'error') {
    (level === 'error' ? console.error : console.log)(`[${level}] ${msg}` + (extra ? ' ' + JSON.stringify(extra) : ''));
  }
  try {
    const f = ensure();
    rotate(f);
    fs.appendFileSync(f, line + '\n');
  } catch {}
}

module.exports = {
  info: (m, e) => write('info', m, e),
  warn: (m, e) => write('warn', m, e),
  error: (m, e) => write('error', m, e),
};
