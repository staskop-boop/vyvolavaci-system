// AdNa – prihlásenie do prehrávača (Antik TV) vo vloženom okne obrazovky.
//
// Prečo prihlásenie vo vloženom okne zlyhá: prehliadač v okne vloženom do cudzej stránky (vyvolavaci.adna.sk)
// zahodí prihlasovacie cookies, ktoré stránka prehrávača neoznačí „SameSite=None; Secure“ (predvolené je „Lax“),
// a k tomu blokuje cookies tretích strán. Stránka prehrávača potom prihlásenie „nevidí“ a hlási chybné údaje.
//
// Riešenie (len v kioskovom profile obrazovky, bežné prehliadanie neovplyvní):
//  1. v tomto profile povolíme cookies tretích strán,
//  2. každú cookie, ktorú pošle server do vloženého okna, uložíme znova s „SameSite=None; Secure“,
//     takže ju prehliadač vo vloženom okne prijme aj pošle späť.

const PREHRAVAC = ['webtv.sk', 'antik.sk', 'antiktv.sk', 'antik.tv'];
const domenyVOkne = new Set(PREHRAVAC);   // domény, ktoré sa načítali vo vloženom okne (prihlásenie môže ísť cez inú doménu)

function patri(host) {
  host = String(host || '').replace(/^\./, '').toLowerCase();
  for (const d of domenyVOkne) if (host === d || host.endsWith('.' + d)) return true;
  return false;
}
function zaklad(host) { return host.split('.').slice(-2).join('.'); }

async function nacitajDomeny() {
  try { const { domeny } = await chrome.storage.local.get('domeny'); (domeny || []).forEach((d) => domenyVOkne.add(d)); } catch {}
}
function pridajDomenu(host) {
  const d = zaklad(host);
  if (!d || domenyVOkne.has(d)) return;
  domenyVOkne.add(d);
  chrome.storage.local.set({ domeny: [...domenyVOkne] }).catch(() => {});
}

// --- 1. povolenie cookies tretích strán v tomto profile ---
function povolCookies() {
  try { chrome.privacy.websites.thirdPartyCookiesAllowed.set({ value: true }); } catch {}
  for (const d of domenyVOkne) {
    for (const vzor of [`https://${d}/*`, `https://*.${d}/*`]) {
      try { chrome.contentSettings.cookies.set({ primaryPattern: vzor, setting: 'allow' }); } catch {}
    }
  }
}

// --- 2. cookies so SameSite=None ---
function rozober(riadok) {
  const casti = riadok.split(';').map((s) => s.trim());
  const prvy = casti.shift() || '';
  const i = prvy.indexOf('=');
  if (i < 1) return null;
  const c = { name: prvy.slice(0, i).trim(), value: prvy.slice(i + 1).trim(), attrs: {} };
  for (const a of casti) {
    const j = a.indexOf('=');
    const k = (j < 0 ? a : a.slice(0, j)).trim().toLowerCase();
    c.attrs[k] = j < 0 ? true : a.slice(j + 1).trim();
  }
  return c;
}

async function ulozZnova(url, riadok) {
  const c = rozober(riadok);
  if (!c) return;
  const a = c.attrs;
  if (String(a.samesite || '').toLowerCase() === 'none' && a.secure) return;   // už je v poriadku
  if (c.name.startsWith('__Host-') && a.domain) return;
  const u = new URL(url);
  const detail = {
    url: `https://${u.hostname}${a.path || '/'}`,
    name: c.name, value: c.value,
    path: a.path || '/', secure: true, sameSite: 'no_restriction', httpOnly: !!a.httponly,
  };
  if (a.domain && !c.name.startsWith('__Host-')) detail.domain = String(a.domain);
  if (a['max-age'] !== undefined) detail.expirationDate = Date.now() / 1000 + Number(a['max-age']);
  else if (a.expires) { const t = Date.parse(a.expires); if (!Number.isNaN(t)) detail.expirationDate = t / 1000; }
  if (detail.expirationDate !== undefined && detail.expirationDate <= Date.now() / 1000) {
    await chrome.cookies.remove({ url: detail.url, name: c.name }).catch(() => {});   // odhlásenie / mazanie
    return;
  }
  await chrome.cookies.set(detail).catch((e) => console.warn('AdNa: cookie sa nepodarilo uložiť', c.name, e));
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (!d.url.startsWith('https:')) return;
    const host = new URL(d.url).hostname;
    // len to, čo sa deje vo vloženom okne (nie v hlavnom okne stránky AdNa)
    const vOkne = d.type === 'sub_frame' || (d.frameId > 0) || patri(host);
    if (!vOkne) return;
    if (d.type === 'sub_frame') pridajDomenu(host);
    for (const h of d.responseHeaders || []) {
      if (h.name.toLowerCase() === 'set-cookie' && h.value) {
        for (const riadok of h.value.split('\n')) ulozZnova(d.url, riadok);
      }
    }
  },
  { urls: ['https://*/*'] },
  ['responseHeaders', 'extraHeaders'],
);

// cookies, ktoré nastaví JavaScript prehrávača alebo ktoré ostali zo starších pokusov
async function opravCookie(c) {
  if (!patri(c.domain) || (c.sameSite === 'no_restriction' && c.secure)) return;
  const host = c.domain.replace(/^\./, '');
  const detail = { url: `https://${host}${c.path}`, name: c.name, value: c.value, path: c.path, secure: true,
    sameSite: 'no_restriction', httpOnly: c.httpOnly, storeId: c.storeId };
  if (!c.hostOnly) detail.domain = c.domain;
  if (!c.session && c.expirationDate) detail.expirationDate = c.expirationDate;
  if (c.partitionKey) detail.partitionKey = c.partitionKey;
  await chrome.cookies.set(detail).catch(() => {});
}
chrome.cookies.onChanged.addListener(({ removed, cookie }) => { if (!removed) opravCookie(cookie); });

async function opravVsetky() {
  for (const d of domenyVOkne) {
    const zoznam = await chrome.cookies.getAll({ domain: d }).catch(() => []);
    for (const c of zoznam) await opravCookie(c);
  }
}

async function start() { await nacitajDomeny(); povolCookies(); await opravVsetky(); }
chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
start();
