'use strict';
// Simulovaná sieťová ESC/POS tlačiareň pre testy (TCP). Režimy: ok | paperOut | silent | cover
const net = require('node:net');

function fakePrinter(mode = 'ok') {
  const state = { mode, jobs: [], connections: 0 };
  const server = net.createServer((sock) => {
    state.connections++;
    const chunks = [];
    sock.on('data', (d) => {
      chunks.push(d);
      if (state.mode === 'silent') return;
      // odpovedáme na každý DLE EOT n
      for (let i = 0; i < d.length - 2; i++) {
        if (d[i] === 0x10 && d[i + 1] === 0x04) {
          const n = d[i + 2];
          if (n === 2) sock.write(Buffer.from([state.mode === 'cover' ? 0x16 : (state.mode === 'paperOut' ? 0x32 : 0x12)]));
          else if (n === 4) sock.write(Buffer.from([state.mode === 'paperOut' ? 0x72 : 0x12]));
          else sock.write(Buffer.from([0x12]));
        }
      }
    });
    sock.on('end', () => { const all = Buffer.concat(chunks); if (all.includes(Buffer.from([0x1b, 0x40]))) state.jobs.push(all); sock.end(); });
    sock.on('error', () => {});
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ state, port: server.address().port, close: () => new Promise((rr) => server.close(rr)) })));
}

module.exports = { fakePrinter };
