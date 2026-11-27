'use strict';
// Obnova hesla správcu na diaľku (2026-11-27, Pali: „nastav mi nové prihlásenie, neviem sa vôbec prihlásiť“).
//
// Server v ambulancii nemá zvonku žiadny správcovský prístup, ale každých 5 minút si sťahuje vetvu main.
// Postup bez toho, aby heslo niekto videl alebo bolo verejne v repozitári:
//   1. Server si pri prvom spustení vytvorí vlastný pár kľúčov RSA (súkromný kľúč ostáva len v data/obnova-kluc.pem)
//      a verejný kľúč ukazuje na /api/public/obnova-kluc.
//   2. Správca uloží nové heslo ako tajomstvo GitHubu ADNA_NOVE_HESLO a spustí workflow „Obnova hesla správcu“.
//      Workflow si stiahne verejný kľúč servera, heslo ním zašifruje a súbor server/src/obnova-hesla.json zapíše do main.
//   3. Server po aktualizácii (reštarte) súbor rozšifruje svojím súkromným kľúčom a heslo konta nastaví – raz pre každé id.
//      Doterajšie prihlásenia (sestry v ambulancii) ostávajú platné.
// Rozšifrovať to vie len tento server; zapísať súbor do main vie len ten, kto má právo zápisu do repozitára.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const log = require('./log');

const SUBOR = path.join(__dirname, 'obnova-hesla.json');

function kluc(dataDir) {
  const file = path.join(dataDir, 'obnova-kluc.pem');
  let priv;
  try { priv = crypto.createPrivateKey(fs.readFileSync(file, 'utf8')); } catch { priv = null; }
  if (!priv) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    priv = privateKey;
  }
  const pub = crypto.createPublicKey(priv);
  const der = pub.export({ type: 'spki', format: 'der' });
  return { priv, publicKey: pub.export({ type: 'spki', format: 'pem' }), fingerprint: crypto.createHash('sha256').update(der).digest('hex').slice(0, 32) };
}

/** Zašifruje požiadavku verejným kľúčom servera (používa workflow aj testy). RSA-OAEP-SHA256 kľúča AES + AES-256-GCM obsahu. */
function zasifruj(publicKeyPem, fingerprint, ziadost) {
  const k = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([c.update(JSON.stringify(ziadost), 'utf8'), c.final()]);
  const ek = crypto.publicEncrypt({ key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, k);
  return { id: ziadost.id, fingerprint, kluc: ek.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function rozsifruj(priv, s) {
  const k = crypto.privateDecrypt({ key: priv, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(s.kluc, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(s.iv, 'base64'));
  d.setAuthTag(Buffer.from(s.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]).toString('utf8'));
}

/**
 * Pri štarte servera: ak je v kóde požiadavka na obnovu pre tento server a ešte nebola použitá, nastaví heslo.
 * Vracia výsledok (pre testy a log), nikdy heslo.
 */
function pouziObnovu({ db, auth, dataDir, subor = SUBOR }) {
  const k = kluc(dataDir);
  if (!fs.existsSync(subor)) return { stav: 'ziadna', k };
  let s;
  try { s = JSON.parse(fs.readFileSync(subor, 'utf8')); } catch { log.warn('Obnova hesla: súbor sa nedá prečítať'); return { stav: 'chyba', k }; }
  if (s.fingerprint !== k.fingerprint) { log.info('Obnova hesla: požiadavka je pre iný server – preskakujem'); return { stav: 'iny-server', k }; }
  const kluceUzite = `obnovaHesla:${String(s.id).slice(0, 80)}`;
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(kluceUzite)) return { stav: 'uz-pouzita', k };
  let z;
  try { z = rozsifruj(k.priv, s); } catch { log.warn('Obnova hesla: požiadavku sa nepodarilo rozšifrovať'); return { stav: 'chyba', k }; }
  if (z.id !== s.id) { log.warn('Obnova hesla: nesúhlasí id požiadavky'); return { stav: 'chyba', k }; }
  const r = auth.setPasswordKeepSessions(z.username || 'admin', z.password);
  if (r.error) { log.warn('Obnova hesla zlyhala', { dovod: r.error }); return { stav: 'chyba', dovod: r.error, k }; }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(kluceUzite, JSON.stringify({ at: new Date().toISOString(), username: r.username }));
  log.info('Obnova hesla: nové heslo nastavené', { konto: r.username });
  return { stav: 'nastavene', username: r.username, k };
}

module.exports = { kluc, zasifruj, rozsifruj, pouziObnovu, SUBOR };
