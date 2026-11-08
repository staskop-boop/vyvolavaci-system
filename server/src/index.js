'use strict';
const os = require('node:os');
const config = require('./config');
const log = require('./log');
const { createServer } = require('./app');

process.on('uncaughtException', (e) => { log.error('uncaughtException', { err: String(e.stack || e).slice(0, 1000) }); });
process.on('unhandledRejection', (e) => { log.error('unhandledRejection', { err: String(e && e.stack || e).slice(0, 1000) }); });

const s = createServer();
s.server.listen(config.port, config.host, () => {
  log.info('Server AdNa beží', { port: config.port });
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  for (const ip of ips.length ? ips : ['localhost']) {
    console.log(`  Sestra:    http://${ip}:${config.port}/sestra/`);
    console.log(`  Tablet:    http://${ip}:${config.port}/tablet/`);
    console.log(`  Obrazovka: http://${ip}:${config.port}/obrazovka/`);
  }
});
const stop = () => { log.info('Server sa vypína'); s.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
