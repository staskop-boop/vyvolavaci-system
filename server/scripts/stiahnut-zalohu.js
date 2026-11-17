'use strict';
// Stiahne zálohu databázy z iného servera AdNa (prihlásenie správcu) do <dáta>/prenos.db.
// Používa ho deploy/lokalny/prenos-udajov.sh pri presune na lokálny server:
//   ADNA_ZDROJ=https://vyvolavaci.adna.sk ADNA_MENO=admin ADNA_HESLO=… node scripts/stiahnut-zalohu.js
// Heslo sa číta len z premennej prostredia a nikam sa nevypisuje ani neukladá.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../src/config');

async function stiahnut({ zdroj, meno, heslo, ciel, lokalny }) {
  const base = String(zdroj || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Adresa zdroja musí začínať http:// alebo https://');
  if (!meno || !heslo) throw new Error('Chýba meno alebo heslo správcu.');
  const health = await (await fetch(base + '/api/health')).json();
  if (lokalny) {
    const moje = await fetch(lokalny + '/api/health').then((r) => r.json()).catch(() => null);
    if (moje && moje.boot && moje.boot === health.boot) throw new Error('Adresa zdroja už ukazuje na tento server (DNS je prepnuté) – prenos by skopíroval server sám na seba.');
  }
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: meno, password: heslo }) });
  if (!login.ok) throw new Error(login.status === 401 || login.status === 400 ? 'Nesprávne meno alebo heslo správcu.' : `Prihlásenie zlyhalo (HTTP ${login.status}).`);
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('Server nevrátil prihlasovaciu cookie.');
  try {
    const r = await fetch(base + '/api/admin/backup', { headers: { Cookie: cookie } });
    if (r.status === 403) throw new Error('Konto nie je správca – zálohu môže stiahnuť len správca.');
    if (r.status === 404) throw new Error('Zdrojový server ešte nemá verziu so stiahnutím zálohy – počkajte pár minút na jeho aktualizáciu.');
    if (!r.ok) throw new Error(`Stiahnutie zálohy zlyhalo (HTTP ${r.status}).`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.subarray(0, 15).toString('latin1') !== 'SQLite format 3') throw new Error('Stiahnutý súbor nie je databáza.');
    fs.writeFileSync(ciel, buf, { mode: 0o600 });
  } finally {
    await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } }).catch(() => {});
  }
  // kontrola celistvosti a stručný súhrn (bez osobných údajov)
  const db = new DatabaseSync(ciel);
  try {
    const ok = db.prepare('PRAGMA integrity_check').get();
    if (Object.values(ok)[0] !== 'ok') throw new Error('Stiahnutá databáza je poškodená.');
    const n = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    return { konta: n('users'), cisla: n('tickets'), velkost: fs.statSync(ciel).size };
  } catch (e) { db.close(); fs.rmSync(ciel, { force: true }); throw e; } finally { try { db.close(); } catch {} }
}

module.exports = { stiahnut };

if (require.main === module) {
  stiahnut({ zdroj: process.env.ADNA_ZDROJ, meno: process.env.ADNA_MENO, heslo: process.env.ADNA_HESLO,
    ciel: path.join(config.dataDir, 'prenos.db'), lokalny: `http://127.0.0.1:${config.port}` })
    .then((s) => console.log(`Záloha stiahnutá: ${s.konta} kont, ${s.cisla} čísel, ${Math.round(s.velkost / 1024)} kB.`))
    .catch((e) => { console.error('⚠ ' + e.message); process.exit(1); });
}
