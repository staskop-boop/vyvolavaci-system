'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { freshDataDir, start, setupAndLogin } = require('./helpers');

freshDataDir();

test('nasadenie: cookie je Secure len pri HTTPS (cloudflared na tom istom PC), v LAN cez http bez Secure', async (t) => {
  const s = await start();
  t.after(() => s.close());
  await setupAndLogin(s);
  const login = (headers) => fetch(s.base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ username: 'personal', password: 'Testovacie-heslo-1' }),
  });
  const http = (await login({})).headers.get('set-cookie');
  assert.ok(http && !/;\s*Secure/i.test(http), 'v LAN cez http nesmie byť Secure');
  const https = (await login({ 'X-Forwarded-Proto': 'https' })).headers.get('set-cookie');
  assert.match(https, /;\s*Secure/i, 'cez tunel (HTTPS) musí byť Secure');
});
