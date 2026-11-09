// AdNa – „celá obrazovka“ prehrávača vo vloženom okne = celá TV zóna, nie celý monitor.
// Beží len vo vloženom okne (nie keď je webtv.sk otvorený samostatne). Tlačidlo roztiahnutia prehrávača
// zväčší obraz na celé vložené okno (TV zónu); Esc alebo to isté tlačidlo ho vráti späť.
(() => {
  if (window.top === window) return;
  const ATTR = 'data-adna-zona', PREDOK = 'data-adna-predok';
  const css = document.createElement('style');
  css.textContent = `
    html.adna-zona-on, html.adna-zona-on body { overflow: hidden !important; background: #000 !important; }
    html.adna-zona-on body * { visibility: hidden !important; }
    html.adna-zona-on [${ATTR}], html.adna-zona-on [${ATTR}] * { visibility: visible !important; }
    [${PREDOK}] { transform: none !important; filter: none !important; perspective: none !important; contain: none !important; will-change: auto !important; }
    [${ATTR}] { position: fixed !important; inset: 0 !important; left: 0 !important; top: 0 !important; width: 100vw !important; height: 100vh !important;
      max-width: none !important; max-height: none !important; min-width: 0 !important; min-height: 0 !important; margin: 0 !important;
      z-index: 2147483647 !important; background: #000 !important; transform: none !important; border: 0 !important; }
    video[${ATTR}], [${ATTR}] video { object-fit: contain !important; }`;
  let el = null;
  function oznam() {
    for (const t of ['fullscreenchange', 'webkitfullscreenchange']) { (el || document).dispatchEvent(new Event(t, { bubbles: true })); document.dispatchEvent(new Event(t)); }
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  }
  function zapni(e) {
    if (!(e instanceof Element) || el === e) return;
    if (el) vypni(true);
    el = e;
    if (!css.isConnected) (document.head || document.documentElement).appendChild(css);
    e.setAttribute(ATTR, '');
    for (let p = e.parentElement; p; p = p.parentElement) p.setAttribute(PREDOK, '');
    document.documentElement.classList.add('adna-zona-on');
    window.parent.postMessage({ adnaZona: true }, '*');   // ak je prehrávač ešte vo vnorenom okne, roztiahne sa aj to
    setTimeout(oznam);
  }
  function vypni(tichy) {
    if (!el) return;
    el.removeAttribute(ATTR);
    for (const p of document.querySelectorAll(`[${PREDOK}]`)) p.removeAttribute(PREDOK);
    el = null;
    document.documentElement.classList.remove('adna-zona-on');
    if (!tichy) { window.parent.postMessage({ adnaZona: false }, '*'); setTimeout(oznam); }
  }
  const ziadost = function () { zapni(this); return Promise.resolve(); };
  for (const n of ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen', 'mozRequestFullScreen', 'msRequestFullscreen']) Element.prototype[n] = ziadost;
  HTMLVideoElement.prototype.webkitEnterFullscreen = function () { zapni(this); };
  HTMLVideoElement.prototype.webkitEnterFullScreen = HTMLVideoElement.prototype.webkitEnterFullscreen;
  const koniec = function () { vypni(); return Promise.resolve(); };
  for (const n of ['exitFullscreen', 'webkitExitFullscreen', 'webkitCancelFullScreen', 'mozCancelFullScreen', 'msExitFullscreen']) Document.prototype[n] = koniec;
  const vlastnost = (n, get) => { try { Object.defineProperty(Document.prototype, n, { configurable: true, get }); } catch {} };
  for (const n of ['fullscreenElement', 'webkitFullscreenElement', 'webkitCurrentFullScreenElement', 'mozFullScreenElement', 'msFullscreenElement']) vlastnost(n, () => el);
  for (const n of ['fullscreenEnabled', 'webkitFullscreenEnabled', 'mozFullScreenEnabled']) vlastnost(n, () => true);
  for (const n of ['fullscreen', 'webkitIsFullScreen', 'mozFullScreen']) vlastnost(n, () => !!el);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el) vypni(); }, true);
  // vnorené okno prehrávača (napr. iná doména vo webtv.sk) požiadalo o roztiahnutie → roztiahneme jeho rám
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d.adnaZona !== 'boolean') return;
    const f = [...document.querySelectorAll('iframe')].find((x) => x.contentWindow === e.source);
    if (!f) return;
    if (d.adnaZona) zapni(f); else if (el === f) vypni();
  });
})();
