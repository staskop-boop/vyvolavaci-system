'use strict';
// Nastavenie / obnova hesla personálu z príkazového riadka (heslo sa zadáva skryto, nikde sa neukladá v čitateľnej podobe).
const readline = require('node:readline');
const config = require('./config');
const db = require('./db');
const { Auth, validatePassword } = require('./auth');

function ask(q, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); else rl.output.write(''); };
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}

(async () => {
  const database = db.open(config.dbFile);
  const auth = new Auth(database);
  const pw = process.env.ADNA_NEW_PASSWORD || await ask('Nové heslo personálu (min. 10 znakov): ', true);
  const err = validatePassword(pw);
  if (err) { console.error(err); process.exit(1); }
  if (!process.env.ADNA_NEW_PASSWORD) {
    const pw2 = await ask('Zopakujte heslo: ', true);
    if (pw !== pw2) { console.error('Heslá sa nezhodujú.'); process.exit(1); }
  }
  auth.createOrResetUser('personal', pw, 'admin');
  try { require('node:fs').rmSync(require('node:path').join(config.dataDir, 'SETUP-KOD.txt')); } catch {}
  console.log('Heslo pre konto „personal“ bolo nastavené. Všetky doterajšie prihlásenia boli zrušené.');
  database.close();
})();
