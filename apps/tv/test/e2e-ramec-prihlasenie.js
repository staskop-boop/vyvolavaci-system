// E2E test rozšírenia rozsirenie-tv-ramec: prihlásenie do prehrávača vo vloženom okne obrazovky.
// Napodobní webtv.sk (zakazuje vloženie, prihlasovacia cookie bez SameSite) a overí, že bez rozšírenia sa
// prihlásenie vo vloženom okne „nechytí“ a s rozšírením áno. Spustenie: node apps/tv/test/e2e-ramec-prihlasenie.js
'use strict';
const { chromium } = require('playwright');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

const ROZSIRENIE = path.resolve(__dirname, '..', 'minipc', 'rozsirenie-tv-ramec');
const PORT = Number(process.env.ADNA_TEST_PORT || 8443);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adna-ramec-'));
let ok = 0;
async function step(name, fn) { try { await fn(); ok++; console.log('OK   ' + name); } catch (e) { console.log('FAIL ' + name + '\n     ' + e.message); throw e; } }

// samopodpísaný certifikát pre testovacie domény (prehliadač ho prijme s --ignore-certificate-errors)
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test',
  '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem')], { stdio: 'ignore' });

const server = https.createServer({ key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: fs.readFileSync(path.join(tmp, 'c.pem')) }, (req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  if (host === 'obrazovka.test') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(`<!doctype html><title>AdNa</title><iframe id="tv" src="https://webtv.sk:${PORT}/" style="width:800px;height:400px"></iframe>`);
  }
  // napodobnenina webtv.sk
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  if (req.method === 'POST' && req.url === '/prihlasenie') {
    res.setHeader('Set-Cookie', ['relacia=prihlaseny; Path=/; HttpOnly', 'jazyk=sk; Path=/; Max-Age=3600']);
    res.statusCode = 303; res.setHeader('Location', '/'); return res.end();
  }
  if (host === 'player.antik.sk') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end('<div id="p2" style="width:200px;height:100px;background:#123"></div><button id="fs2" onclick="p2.requestFullscreen()">⛶</button>');
  }
  const prihlaseny = /(?:^|;\s*)relacia=prihlaseny/.test(req.headers.cookie || '');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(prihlaseny ? `<p id="stav">PRIHLASENY</p><div style="transform:translateZ(0)"><div id="prehravac" style="width:300px;height:150px;background:#333"><video></video>
      <button id="fs" onclick="document.fullscreenElement ? document.exitFullscreen() : prehravac.requestFullscreen()">⛶</button></div></div>
      <iframe id="vnor" src="https://player.antik.sk:${PORT}/" style="width:320px;height:180px"></iframe>`
    : '<form method="post" action="/prihlasenie"><button id="prihlas">Prihlásiť</button></form><p id="stav">ODHLASENY</p>');
});

// pôvodné rozšírenie v1.0 (len povolí vloženie, cookies nerieši) – tak, ako ho mal Pali, keď prihlásenie zlyhalo
const STARE = path.join(tmp, 'stare-rozsirenie');
fs.mkdirSync(STARE);
fs.copyFileSync(path.join(ROZSIRENIE, 'rules.json'), path.join(STARE, 'rules.json'));
fs.writeFileSync(path.join(STARE, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'stare', version: '1.0',
  permissions: ['declarativeNetRequest'], host_permissions: ['https://webtv.sk/*', 'https://*.webtv.sk/*'],
  declarative_net_request: { rule_resources: [{ id: 'ramec', enabled: true, path: 'rules.json' }] } }));

async function skus(rozsirenie, overZonu) {
  const profil = fs.mkdtempSync(path.join(tmp, 'profil-'));
  const args = [`--host-resolver-rules=MAP obrazovka.test 127.0.0.1, MAP webtv.sk 127.0.0.1, MAP player.antik.sk 127.0.0.1`, '--ignore-certificate-errors',
    '--test-third-party-cookie-phaseout', '--no-proxy-server'];   // cookies tretích strán blokované ako v novom Chrome/Edge
  args.push(`--disable-extensions-except=${rozsirenie}`, `--load-extension=${rozsirenie}`);
  const ctx = await chromium.launchPersistentContext(profil, { headless: true, channel: 'chromium', args });
  try {
    if (rozsirenie === ROZSIRENIE) {
      let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 10000 });
      assert.ok(sw.url().endsWith('/pozadie.js'));
      await new Promise((r) => setTimeout(r, 500));
    }
    const page = await ctx.newPage();
    await page.goto(`https://obrazovka.test:${PORT}/`);
    const f = page.frameLocator('#tv');
    await f.locator('#stav').waitFor({ timeout: 8000 });     // obe verzie rozšírenia povolia vloženie
    await f.locator('#prihlas').click();
    await new Promise((r) => setTimeout(r, 1000));
    // prehrávač po prihlásení obnoví stránku – cookie musí ostať aj potom
    await page.reload();
    await f.locator('#stav').waitFor({ timeout: 8000 });
    const stav = await f.locator('#stav').textContent();
    if (overZonu) await overZonu(page, f);
    return stav;
  } catch (e) {
    return 'CHYBA: ' + e.message.split('\n')[0];
  } finally { await ctx.close(); }
}

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  try {
    await step('so starým rozšírením 1.0 sa prehrávač vo vloženom okne zobrazí, ale neprihlási (stav pred opravou)', async () => {
      const s = await skus(STARE);
      assert.equal(s, 'ODHLASENY');
    });
    let zona = null;
    await step('s novým rozšírením sa prehrávač vo vloženom okne zobrazí, prihlási a prihlásenie vydrží', async () => {
      const s = await skus(ROZSIRENIE, async (page, f) => {
        const rozmer = (sel) => f.locator(sel).evaluate((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
        const z = {};
        await f.locator('#fs').click();
        await page.waitForTimeout(300);
        z.prehravac = await rozmer('#prehravac');
        z.fsEl = await f.locator('body').evaluate(() => document.fullscreenElement && document.fullscreenElement.id);
        z.hore = await page.evaluate(() => document.fullscreenElement);
        await f.locator('#fs').click();                      // to isté tlačidlo vráti späť
        await page.waitForTimeout(300);
        z.spat = await rozmer('#prehravac');
        await f.frameLocator('#vnor').locator('#fs2').click();   // prehrávač vo vnorenom okne inej domény
        await page.waitForTimeout(500);
        z.vnor = await rozmer('#vnor');
        z.p2 = await f.frameLocator('#vnor').locator('#p2').evaluate((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
        await page.keyboard.press('Escape');
        zona = z;
      });
      assert.equal(s, 'PRIHLASENY');
    });
    await step('tlačidlo roztiahnutia zväčší prehrávač na celú TV zónu (vložené okno), nie na celý monitor; späť tým istým tlačidlom', async () => {
      assert.deepEqual(zona.prehravac, [800, 400], JSON.stringify(zona));
      assert.equal(zona.fsEl, 'prehravac');
      assert.equal(zona.hore, null, 'stránka AdNa ostáva, monitor sa neprepne na celú obrazovku');
      assert.deepEqual(zona.spat, [300, 150]);
    });
    await step('to isté funguje aj pre prehrávač vo vnorenom okne inej domény', async () => {
      assert.deepEqual(zona.vnor, [800, 400], JSON.stringify(zona));
      assert.deepEqual(zona.p2, [800, 400]);
    });
    console.log(`\n${ok}/4 OK`);
  } finally { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch(() => process.exit(1));
