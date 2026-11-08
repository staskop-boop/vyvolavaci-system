'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Každý test má vlastný dátový adresár. Musí sa nastaviť PRED načítaním src/config.js. */
function freshDataDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'adna-test-'));
  process.env.ADNA_DATA_DIR = d;
  process.env.ADNA_QUIET = '1';
  return d;
}

async function start(opts = {}) {
  const { createServer } = require('../src/app');
  const s = createServer({ silentSetup: true, news: false, ...opts });
  await new Promise((r) => s.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.server.address().port}`;
  return { ...s, base };
}

/** Malý HTTP klient s cookie. */
function client(base) {
  let cookie = '';
  async function req(method, p, body) {
    const res = await fetch(base + p, {
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  }
  return { get: (p) => req('GET', p), post: (p, b = {}) => req('POST', p, b), put: (p, b) => req('PUT', p, b), del: (p) => req('DELETE', p), get cookie() { return cookie; } };
}

async function setupAndLogin(s, password = 'Testovacie-heslo-1') {
  const c = client(s.base);
  const r1 = await c.post('/api/setup', { setupCode: s.auth.setupCode, password });
  if (r1.status !== 200) throw new Error('setup failed ' + JSON.stringify(r1.data));
  const r2 = await c.post('/api/auth/login', { username: 'personal', password });
  if (r2.status !== 200) throw new Error('login failed');
  return c;
}

module.exports = { freshDataDir, start, client, setupAndLogin };
