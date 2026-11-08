'use strict';
// Konzistentná záloha databázy (aj počas behu servera): node scripts/zaloha.js [cieľový adresár]
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('../src/config');
const dir = path.resolve(process.argv[2] || path.join(config.dataDir, 'zalohy'));
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(dir, `adna-${stamp}.db`);
const db = new DatabaseSync(config.dbFile);
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();
console.log('Záloha vytvorená:', target);
