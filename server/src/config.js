'use strict';
const path = require('node:path');

const dataDir = path.resolve(process.env.ADNA_DATA_DIR || path.join(__dirname, '..', 'data'));

module.exports = {
  port: Number(process.env.ADNA_PORT || process.env.PORT || 8080),
  host: process.env.ADNA_HOST || '0.0.0.0',
  dataDir,
  dbFile: path.join(dataDir, 'adna.db'),
  logDir: path.join(dataDir, 'logs'),
  timeZone: 'Europe/Bratislava',
  appsDir: path.resolve(process.env.ADNA_APPS_DIR || path.join(__dirname, '..', '..', 'apps')),
  sharedDir: path.resolve(path.join(__dirname, '..', '..', 'shared')),
  sessionHours: 12,
  // Ak beží server za HTTPS reverznou proxy, nastavte ADNA_SECURE_COOKIE=1
  secureCookie: process.env.ADNA_SECURE_COOKIE === '1',
  quiet: process.env.ADNA_QUIET === '1',
};
