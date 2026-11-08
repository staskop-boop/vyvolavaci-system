'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { freshDataDir, start, client, setupAndLogin } = require('./helpers');

freshDataDir();

test('v3.1: nastavenie hlasového hlásenia', async (t) => {
  const s = await start();
  t.after(() => s.close());
  const admin = await setupAndLogin(s);
  const pub = client(s.base);
  let st = (await pub.get('/api/display/state')).data;
  assert.deepEqual(st.voice, { enabled: true, rate: 0.9, room: true });
  let r = await admin.put('/api/admin/settings', { voice: { rate: 3 } });
  assert.equal(r.status, 400);
  r = await admin.put('/api/admin/settings', { voice: { rate: 1.1, room: false } });
  assert.equal(r.status, 200);
  st = (await pub.get('/api/display/state')).data;
  assert.deepEqual(st.voice, { enabled: true, rate: 1.1, room: false });
  await admin.put('/api/admin/settings', { soundEnabled: false });
  assert.equal((await pub.get('/api/display/state')).data.voice.enabled, false, 'bez zvuku ani hlas');
});
