// Obrazovka v čakárni AdNa v3 – dizajn z Claude Design (2026-11-08).
// Vľavo „Práve vyšetrujeme“ (číslo v každej ambulancii), „Nasledujú“ s odchýlkou od termínu, informácie pre pacientov;
// vpravo TV program; dole lišta správ. Zobrazuje iba čísla/písmená kartičiek – nikdy osobné údaje pacientov.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = {
    stage: $('stage'), deco: $('deco'), lights: $('lights'), bgStop0: $('bgStop0'), bgStop1: $('bgStop1'),
    hTitle: $('hTitle'), hAddress: $('hAddress'), hPhone: $('hPhone'), hPhoneBox: $('hPhoneBox'),
    weather: $('weather'), wIcon: $('wIcon'), wTemp: $('wTemp'), wText: $('wText'), wDays: $('wDays'),
    clock: $('clock'), clockSec: $('clockSec'), date: $('date'), nameday: $('nameday'),
    left: $('left'), callCard: $('callCard'), ccGrid: $('ccGrid'), code: $('callCode'), callDoc: $('callDoc'), callDocImg: $('callDocImg'),
    callDocInit: $('callDocInit'), callPoint: $('callPoint'), callDocCap: $('callDocCap'), room: $('callRoom'), callSub: $('callSub'), callBar: $('callBar'),
    roomsCard: $('roomsCard'), roomRows: $('roomRows'), rcCount: $('rcCount'),
    queueList: $('queueList'), queueEmpty: $('queueEmpty'), queueWait: $('queueWait'), infoList: $('infoList'),
    tvZone: $('tvZone'), tvVideo: $('tvVideo'), tvPh: $('tvPlaceholder'), tvLabel: $('tvLabel'), greeting: $('greeting'), greetingText: $('greetingText'),
    tvCall: $('tvCall'), tvCallCode: $('tvCallCode'), tvCallImg: $('tvCallImg'), tvCallTitle: $('tvCallTitle'), tvCallSub: $('tvCallSub'),
    tvAnnounce: $('tvAnnounce'), tvAnnText: $('tvAnnText'),
    ticker: $('ticker'), tickerLabelText: $('tickerLabelText'), tickerMove: $('tickerMove'), tickerAnn: $('tickerAnn'), tickerSrc: $('tickerSrc'),
    offline: $('offline'), soundWarn: $('soundWarn'), overlay: $('soundOverlay'), soundBtn: $('soundBtn'), soundLater: $('soundLater'),
  };
  const isApp = !!(window.AdNaNative && typeof window.AdNaNative.isApp === 'function');
  const esc = (s) => AdNa.esc(s);

  // Testovací háčik (používa automatický test; bez vplyvu na prevádzku).
  const T = window.__adnaTest = { chimes: 0, attempts: 0, blocked: 0, flashes: 0, states: 0, lastCallId: null, shown: [] };
  // Stav pre kontrolu živosti z Android aplikácie / mini PC.
  const health = window.AdNaDisplay = { ok: false, online: false, lastMessageAt: 0 };

  const params = new URLSearchParams(location.search);
  if (params.get('zona') === 'prazdna') document.body.classList.add('zone-empty');
  let state = null;
  let clockOffset = 0;   // serverový čas − lokálny čas (TV nemusí mať presné hodiny)
  let tvSrc = null;
  let soundEnabled = true;
  let overlayDismissed = false;

  // ---------- mierka plochy 1920 × 1080 a ochrana pred vypálením ----------
  let shift = 0;
  function fit() {
    const s = Math.min(innerWidth / 1920, innerHeight / 1080);
    const x = (innerWidth - 1920 * s) / 2, y = (innerHeight - 1080 * s) / 2;
    const d = [[0, 0], [2, 0], [0, 2], [-2, 0], [0, -2]][shift % 5];   // raz za hodinu posun o ±2 px
    el.stage.style.transform = `translate(${x + d[0] * s}px, ${y + d[1] * s}px) scale(${s})`;
    publishLayout();
  }
  addEventListener('resize', () => { fit(); renderQueue(); });
  setInterval(() => { shift++; fit(); }, 3600_000);

  // ---------- hodiny, dátum, meniny ----------
  const TZ = 'Europe/Bratislava';
  const now = () => Date.now() + clockOffset;
  const partsFmt = new Intl.DateTimeFormat('sk-SK', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long', hourCycle: 'h23' });
  function parts(t) { const o = {}; for (const p of partsFmt.formatToParts(new Date(t))) o[p.type] = p.value; return o; }
  const pad = (n) => String(n).padStart(2, '0');
  let meniny = null, lastDay = '';
  fetch('data/meniny-sk.json').then((r) => r.json()).then((j) => { meniny = j; lastDay = ''; tickClock(); }).catch(() => {});
  function tickClock() {
    const p = parts(now());
    const hm = `${pad(p.hour)}:${p.minute}`;
    if (el.clock.firstChild ? el.clock.firstChild.nodeValue !== hm : true) el.clock.textContent = hm;
    el.clockSec.textContent = p.second;
    const dayKey = `${p.year}-${p.month}-${p.day}`;
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      const wd = p.weekday.charAt(0).toUpperCase() + p.weekday.slice(1);
      el.date.textContent = `${wd} · ${p.day}. ${p.month}. ${p.year}`;
      const nd = meniny && meniny[`${pad(p.month)}-${pad(p.day)}`];
      // štátny sviatok je v kalendári uvedený názvom (napr. „Nový rok“) – vtedy „dnes je …“
      const holiday = nd && /\s/.test(nd.replace(/,\s*/g, ','));
      el.nameday.innerHTML = nd ? ` · ${holiday ? 'dnes je' : 'meniny má'} <strong>${esc(nd)}</strong>` : '';
      applyTheme();
    }
  }

  // ---------- zvuk (WebAudio „marimba“, bez zvukových súborov) ----------
  let ctx = null;
  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch { return null; }
      ctx.onstatechange = updateSoundUi;
    }
    return ctx;
  }
  function soundActive() { return !!ctx && ctx.state === 'running'; }
  function tone(freq, start, dur, gain) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain, start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(ctx.destination);
    o.start(start); o.stop(start + dur + 0.05);
  }
  /** Úder marimby: základný tón + dva rýchlo doznievajúce alikvoty. */
  function marimba(freq, start, dur) {
    for (const [mul, g, decay] of [[1, 0.32, 7], [4, 0.08, 18], [10, 0.016, 30]]) {
      const o = ctx.createOscillator(), gn = ctx.createGain();
      o.type = 'sine'; o.frequency.value = freq * mul;
      gn.gain.setValueAtTime(0.0001, start);
      gn.gain.linearRampToValueAtTime(g, start + 0.012);
      gn.gain.setTargetAtTime(0.0001, start + 0.012, dur / decay);
      o.connect(gn).connect(ctx.destination);
      o.start(start); o.stop(start + dur + 0.1);
    }
  }
  /** Zvukový signál pri vyvolaní (~1,3 s): „marimba“ G5 – H5 – D6 (vybral Pali 2026-11-08). */
  function chime() {
    T.attempts++;
    if (!soundEnabled) return;
    const c = audio();
    if (!c) return;
    if (c.state !== 'running') { c.resume().catch(() => {}); }
    if (c.state !== 'running') { T.blocked++; updateSoundUi(); return; }
    const t = c.currentTime + 0.05;
    marimba(783.99, t, 0.7); marimba(987.77, t + 0.2, 0.7); marimba(1174.66, t + 0.4, 0.9);
    T.chimes++;
  }
  // ---------- v3.1: hlasové hlásenie po signáli (offline hlas prehliadača / Windows) ----------
  const ONES = ['nula', 'jeden', 'dva', 'tri', 'štyri', 'päť', 'šesť', 'sedem', 'osem', 'deväť', 'desať', 'jedenásť', 'dvanásť', 'trinásť',
    'štrnásť', 'pätnásť', 'šestnásť', 'sedemnásť', 'osemnásť', 'devätnásť'];
  const TENS = ['', '', 'dvadsať', 'tridsať', 'štyridsať', 'päťdesiat', 'šesťdesiat', 'sedemdesiat', 'osemdesiat', 'deväťdesiat'];
  const HUND = ['', 'sto', 'dvesto', 'tristo', 'štyristo', 'päťsto', 'šesťsto', 'sedemsto', 'osemsto', 'deväťsto'];
  /** 0 – 9999 slovom po slovensky („dvadsaťpäť“, „stodvanásť“). */
  function skNumber(n) {
    n = Number(n);
    if (!Number.isInteger(n) || n < 0 || n > 9999) return String(n).split('').map((d) => ONES[d] || d).join(' ');
    if (n < 20) return ONES[n];
    let out = '';
    if (n >= 1000) { const t = Math.floor(n / 1000); out += t === 1 ? 'tisíc' : (t === 2 ? 'dve' : ONES[t]) + 'tisíc'; n %= 1000; if (!n) return out; }
    if (n >= 100) { out += HUND[Math.floor(n / 100)]; n %= 100; if (!n) return out; }
    if (n < 20) return out + ONES[n];
    return out + TENS[Math.floor(n / 10)] + (n % 10 ? ONES[n % 10] : '');
  }
  const LETTER = { A: 'á', Á: 'dlhé á', Ä: 'široké é', B: 'bé', C: 'cé', Č: 'čé', D: 'dé', Ď: 'ďé', E: 'é', F: 'ef', G: 'gé', H: 'há', I: 'í', J: 'jé', K: 'ká',
    L: 'el', M: 'em', N: 'en', Ň: 'eň', O: 'ó', Ô: 'uo', P: 'pé', Q: 'kvé', R: 'er', S: 'es', Š: 'eš', T: 'té', Ť: 'ťé', U: 'ú', V: 'vé', W: 'dvojité vé',
    X: 'iks', Y: 'ypsilon', Z: 'zet', Ž: 'žet' };
  /** Text hlásenia: „Číslo dvadsaťpäť“, „Písmeno bé“, „Označenie ká dvanásť“. */
  function codeWords(code) {
    const c = String(code).toUpperCase();
    if (/^\d+$/.test(c)) return 'Číslo ' + skNumber(Number(c));
    if (/^\p{L}$/u.test(c)) return 'Písmeno ' + (LETTER[c] || c);
    return 'Označenie ' + (c.match(/\d+|\p{L}/gu) || []).map((p) => (/\d/.test(p) ? skNumber(Number(p)) : LETTER[p] || p)).join(' ');
  }
  const FEM = { 1: 'jedna', 2: 'dva', 3: 'tri', 4: 'štyri' };
  function roomWords(call) {
    const n = doorNo(call.roomName);
    if (n && /ambulan/i.test(call.roomName || '')) return 'ambulancia ' + (FEM[n] || skNumber(Number(n)));
    return call.roomName || '';
  }
  /** Znenie (Pali 2026-11-08): prosim = „Číslo dvadsaťpäť, prosím, môžete vstúpiť do ambulancie číslo jeden.“,
   *  nechsapaci = „…, nech sa páči, vstúpte do ambulancie číslo jeden.“, kratke = „Číslo dvadsaťpäť, ambulancia jedna.“ */
  const PHRASE = { prosim: 'prosím, môžete vstúpiť', nechsapaci: 'nech sa páči, vstúpte' };
  function announcementText(call) {
    const v = (state && state.voice) || {};
    const head = codeWords(call.code), room = v.room !== false;
    const phrase = PHRASE[v.style || 'prosim'];
    if (!phrase) { const r = room ? roomWords(call) : ''; return head + (r ? ', ' + r : '') + '.'; }
    if (!room) return head + ', ' + phrase + '.';
    const n = doorNo(call.roomName);
    if (n && /ambulan/i.test(call.roomName || '')) return head + ', ' + phrase + ' do ambulancie číslo ' + skNumber(Number(n)) + '.';
    return head + ', ' + phrase + '.' + (call.roomName ? ' ' + call.roomName + '.' : '');
  }
  /** Slovenský hlas: prednosť má ženský prirodzený (Edge: „Viktória Online (Natural)“), mužský len ak iný nie je. */
  let skVoice = null;
  function pickVoice() {
    const vs = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
    const sk = vs.filter((v) => /^sk([-_]|$)/i.test(v.lang));
    // Pali chce ženský hlas (2026-11-08): Viktória (Edge, online), Laura (Apple), Google slovenčina; mužský (Lukáš, Filip) len ako záloha
    const female = (v) => /viktor|laura|zuzana|google/i.test(v.name), male = (v) => /luk[aá]s|filip|michal/i.test(v.name);
    skVoice = sk.find((v) => female(v) && /natural|online/i.test(v.name)) || sk.find(female) || sk.find((v) => !male(v)) || sk[0] || null;
    T.voice = skVoice ? skVoice.name : null;
    updateVoiceUi();
    return skVoice;
  }
  if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  function voiceOn() { return !!(state && state.voice && state.voice.enabled) && soundEnabled; }
  function updateVoiceUi() {
    const w = $('voiceWarn');
    if (w) w.classList.toggle('hidden', !voiceOn() || !!skVoice);
  }
  /** Hlásenie prehrá po doznení signálu (~1,4 s). */
  function speakCall(call, delayMs = 1450) {
    if (!voiceOn()) return;
    const text = announcementText(call);
    T.lastSpeech = text;
    if (!window.speechSynthesis || !(skVoice || pickVoice())) { T.speechMissing = (T.speechMissing || 0) + 1; return; }
    setTimeout(() => {
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.voice = skVoice; u.lang = skVoice.lang || 'sk-SK';
        u.rate = (state.voice && state.voice.rate) || 0.9; u.pitch = 1; u.volume = 1;
        speechSynthesis.speak(u);
        T.spoken = (T.spoken || 0) + 1;
      } catch {}
    }, delayMs);
  }
  if (params.get('hlas') === 'test') setTimeout(() => { chime(); speakCall({ code: '25', roomName: 'Ambulancia č. 1' }); }, 2500);

  function unlockSound() {
    const c = audio();
    if (!c) return;
    c.resume().then(() => { try { tone(440, c.currentTime + 0.01, 0.05, 0.0002); } catch {} updateSoundUi(); }).catch(updateSoundUi);
  }
  function updateSoundUi() {
    const blocked = soundEnabled && !soundActive();
    el.soundWarn.classList.toggle('hidden', !blocked);
    const showOverlay = blocked && !overlayDismissed;
    const wasHidden = el.overlay.classList.contains('hidden');
    el.overlay.classList.toggle('hidden', !showOverlay);
    if (showOverlay && wasHidden) setTimeout(() => el.soundBtn.focus(), 30);
  }
  el.soundBtn.addEventListener('click', () => { unlockSound(); });
  el.soundLater.addEventListener('click', () => { overlayDismissed = true; updateSoundUi(); });
  document.addEventListener('keydown', (e) => {
    const k = e.key;
    if (!el.overlay.classList.contains('hidden')) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Tab') { e.preventDefault(); (document.activeElement === el.soundBtn ? el.soundLater : el.soundBtn).focus(); }
      return;
    }
    if ((k === 'Enter' || k === ' ') && soundEnabled && !soundActive()) { overlayDismissed = false; unlockSound(); updateSoundUi(); }
  });
  document.addEventListener('pointerdown', () => { if (soundEnabled && !soundActive()) unlockSound(); });

  // ---------- pomocné: lekár, dvere, smer ----------
  const noPost = (n) => (n ? String(n).split(',')[0].trim() : '');                 // bez titulov za menom
  function shortDoc(n) {                                                            // „MUDr. Staško“
    if (!n) return '';
    const base = noPost(n).split(/\s+/);
    const titles = base.filter((w) => /\.$/.test(w)), names = base.filter((w) => !/\.$/.test(w));
    return names.length >= 2 ? [...titles, names[names.length - 1]].join(' ') : noPost(n);
  }
  const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  /** Fotka lekára: assets/doctors/<priezvisko>.jpg (bez diakritiky), inak iniciály. */
  function docPhoto(n) {
    const names = noPost(n).split(/\s+/).filter((w) => w && !/\.$/.test(w));
    return names.length ? `assets/doctors/${fold(names[names.length - 1]).replace(/[^a-z0-9-]/g, '')}.jpg` : '';
  }
  function initials(n) { const names = noPost(n).split(/\s+/).filter((w) => w && !/\.$/.test(w)); return names.slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }
  const missingPhoto = new Set();
  /** Obrázok s náhradou (iniciály), keď fotka chýba. */
  function setPhoto(img, n, onMissing) {
    const src = n ? docPhoto(n) : '';
    if (!src || missingPhoto.has(src)) { img.removeAttribute('src'); img.classList.add('hidden'); onMissing && onMissing(); return; }
    img.classList.remove('hidden');
    img.onerror = () => { missingPhoto.add(src); img.classList.add('hidden'); onMissing && onMissing(); };
    if (img.getAttribute('src') !== src) img.src = src;
  }
  const DIR_TEXT = { right: 'vpravo', left: 'vľavo', straight: 'rovno' };
  const ARROW = { right: 'M5 12h12M12 5l7 7-7 7', left: 'M19 12H7M12 5l-7 7 7 7', straight: 'M12 19V7M5 12l7-7 7 7' };
  const doorNo = (name) => { const m = String(name || '').match(/(\d+)/); return m ? m[1] : ''; };
  function doorText(r) {
    const n = doorNo(r.roomName || r.name), d = DIR_TEXT[r.direction];
    return [n ? `Dvere č. ${n}` : '', d].filter(Boolean).join(' · ');
  }
  const arrowSvg = (dir, size = 20) => (ARROW[dir] ? `<svg aria-hidden="true" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="${ARROW[dir]}"></path></svg>` : '');
  /** Farba ambulancie: 1. červená, 2. sivá, 3. čierna – podľa poradia v zozname ambulancií. */
  function roomColor(roomId) {
    const ids = ((state && state.rooms) || []).map((r) => r.id);
    const i = ids.indexOf(roomId);
    return i < 0 ? 1 : Math.min(i, 2);
  }
  const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}` : `${m} min`);
  const fmtShort = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) : ''}` : `${m} min`);
  const roundMin = (m) => (m >= 30 ? Math.round(m / 5) * 5 : m);   // pri veľkom meškaní presnosť na minútu len klame

  // ---------- odchýlka od termínu ----------
  /**
   * Sklz ambulancie = najväčšie z: meškania nahláseného sestrou, sklzu pri jej poslednom vyvolaní
   * a času od termínu najskôr objednaného čakajúceho (ambulancia stojí → sklz rastie aj bez vyvolania).
   */
  function roomDelay(roomId, s) {
    const r = (s.rooms || []).find((x) => x.id === roomId);
    if (!r) return s.clinicDelayMinutes || 0;
    let d = r.lastCallDelayMinutes ?? 0;
    if (r.reported) d = Math.max(d, r.reported.minutes);
    const first = (s.queue || []).find((q) => q.roomId === roomId && q.plannedAt);
    if (first) d = Math.max(d, Math.round((now() - Date.parse(first.plannedAt)) / 60000));
    return d;
  }
  function deltaFor(q, s) {
    if (!q.plannedAt) return null;
    const sinceSlot = Math.round((now() - Date.parse(q.plannedAt)) / 60000);
    return Math.max(q.roomId != null ? roomDelay(q.roomId, s) : (s.clinicDelayMinutes || 0), sinceSlot);
  }
  function deltaHtml(d, tol) {
    if (d == null) return '<span class="c-delta none">bez termínu</span>';
    if (d > tol) return `<span class="c-delta late">+${fmtShort(roundMin(d))}</span>`;
    if (d < -tol) return `<span class="c-delta early">o ${fmtShort(roundMin(-d))} skôr</span>`;
    return '<span class="c-delta ontime">načas</span>';
  }
  /** Veľké meškanie ambulancie (nahlásené sestrou alebo nad hranicou) → text do riadku ambulancie, inak null. */
  function longDelay(r, s) {
    const lim = s.longDelayMinutes || 30;
    const hasPatients = (s.queue || []).some((q) => q.roomId === r.id);
    const d = roomDelay(r.id, s);
    if (!r.reported && (!hasPatients || d < lim)) return null;
    const min = roundMin(Math.max(d, r.reported ? r.reported.minutes : 0));
    const why = r.reported && r.reported.text ? r.reported.text : 'Predĺžený výkon';
    return `Čakanie dlhšie o ${fmtMin(min)} · ${why}. Ďakujeme za trpezlivosť.`;
  }

  // ---------- Práve vyšetrujeme ----------
  /** Ambulancie, ktoré dnes pracujú (lekár, vyvolané číslo alebo čakajúci); inak prvé dve. Najviac 3. */
  function activeRooms(s) {
    const rooms = s.rooms || [];
    const busy = rooms.filter((r) => r.doctorName || r.current || (s.queue || []).some((q) => q.roomId === r.id));
    return (busy.length ? busy : rooms.slice(0, 2)).slice(0, 3);
  }
  let callingRoomId = null;
  function renderRooms() {
    const s = state;
    if (!s) return;
    let rooms = activeRooms(s);
    const compact = callingRoomId !== null;
    if (compact) rooms = rooms.filter((r) => r.id !== callingRoomId).slice(0, 2);
    el.roomsCard.classList.toggle('compact', compact);
    el.roomsCard.classList.toggle('hidden', compact && !rooms.length);
    el.rcCount.textContent = rooms.length === 1 ? '1 ambulancia' : `${rooms.length} ambulancie`;
    el.roomRows.innerHTML = rooms.map((r) => {
      const c = roomColor(r.id), door = doorText(r), late = longDelay(r, s);
      return `<div class="room" data-room="${r.id}">
        <div class="tile c${c}${r.current ? '' : ' empty'}">${r.current ? esc(r.current) : '–'}</div>
        <div class="r-text">
          <div class="r-kicker">Práve vyšetrujeme</div>
          <div class="r-name">${esc(r.name)}</div>
          ${r.doctorName ? `<div class="r-doc">${esc(compact ? noPost(r.doctorName) : r.doctorName)}${door ? `<span class="door-inline"> · ${esc(door)}</span>` : ''}</div>` : (door ? `<div class="r-doc"><span class="door-inline">${esc(door)}</span></div>` : '')}
          ${door ? `<div class="r-door">${arrowSvg(r.direction)}<span>${esc(door)}</span></div>` : ''}
        </div>
        ${r.doctorName ? `<img class="avatar" alt="${esc(r.doctorName)}" data-doc="${esc(r.doctorName)}">` : '<div></div>'}
        ${late ? `<div class="r-late">${esc(late)}</div>` : ''}
      </div>`;
    }).join('');
    // dlhší názov ambulancie sa radšej zmenší, než aby sa zalomil alebo orezal
    for (const n of el.roomRows.querySelectorAll('.r-name')) { let f = 26; while (n.scrollWidth > n.clientWidth + 1 && f > 17) { f--; n.style.fontSize = f + 'px'; } }
    for (const img of el.roomRows.querySelectorAll('img[data-doc]')) {
      const n = img.dataset.doc;
      setPhoto(img, n, () => { const d = document.createElement('div'); d.className = 'avatar'; d.textContent = initials(n); img.replaceWith(d); });
    }
  }

  // ---------- Nasledujú ----------
  /** Odrážky informácií, ktoré by pretiekli pod lištu, sa skryjú celé (nikdy nie polovičný riadok). */
  function fitInfo() {
    const box = el.infoList.parentElement.getBoundingClientRect();
    let hide = false;
    for (const li of el.infoList.children) { li.classList.remove('cut'); if (hide || li.getBoundingClientRect().bottom > box.bottom - 12) { hide = true; li.classList.add('cut'); } }
  }
  function renderQueue() {
    const s = state;
    if (!s || !Array.isArray(s.queue)) return;
    const tol = s.onTimeMinutes ?? 3;
    const max = callingRoomId !== null ? 8 : 5;
    el.queueList.innerHTML = s.queue.slice(0, max).map((q) => {
      const d = deltaFor(q, s);
      return `<li class="chip c${q.roomId != null ? roomColor(q.roomId) : 1}" data-delta="${d == null ? '' : d}" data-room="${q.roomId ?? ''}"><span class="c-code">${esc(q.code)}</span>${deltaHtml(d, tol)}</li>`;
    }).join('');
    el.queueEmpty.classList.toggle('hidden', s.queue.length > 0);
    el.queueList.classList.toggle('hidden', !s.queue.length);
    // čipy, ktoré sa nezmestia, sa skryjú (nikdy nie polovičný čip)
    const box = el.queueList.getBoundingClientRect();
    for (const li of el.queueList.children) { const r = li.getBoundingClientRect(); li.classList.toggle('cut', r.right > box.right + 1 || r.bottom > box.bottom + 1); }
    // súhrn: najväčší sklz ambulancie, v ktorej niekto čaká
    const withQ = (s.rooms || []).filter((r) => s.queue.some((q) => q.roomId === r.id));
    const ds = withQ.map((r) => roomDelay(r.id, s));
    const anyPlanned = s.queue.some((q) => q.plannedAt);
    const worst = ds.length ? Math.max(...ds) : (anyPlanned ? (s.clinicDelayMinutes || 0) : null);
    const n = s.waitingCount || 0;
    const count = n ? `čaká ${n}` : '';
    if (worst == null || !n) el.queueWait.innerHTML = esc(count);
    else if (worst > tol) el.queueWait.innerHTML = `${count} · meškanie <b class="late">${esc(fmtMin(roundMin(worst)))}</b>`;
    else el.queueWait.innerHTML = `${count} · <b class="ok">podľa plánu</b>`;
  }
  setInterval(() => { renderQueue(); renderRooms(); }, 30000);

  // ---------- informácie pre pacientov ----------
  const INFO_ICONS = [
    '<rect x="3" y="5" width="18" height="14" rx="3"></rect><path d="M3 10h18M7 15h4"></path>',
    '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>',
    '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z"></path><path d="M9 12l2 2 4-4"></path>',
    '<rect x="3" y="5" width="18" height="16" rx="3"></rect><path d="M3 10h18M8 3v4M16 3v4"></path>',
    '<circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16v.5"></path>',
  ];
  let infoKey = '';
  function renderInfo(sc) {
    const items = (sc && sc.info) || [];
    const key = JSON.stringify(items);
    if (key === infoKey) return;
    infoKey = key;
    el.infoList.innerHTML = items.map((t, i) => `<li><svg aria-hidden="true" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#FF6B70" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${INFO_ICONS[i % INFO_ICONS.length]}</svg>
      <span>${esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</span></li>`).join('');
  }
  function renderHeader(sc) {
    if (!sc) return;
    el.hTitle.textContent = sc.title || '';
    el.hAddress.textContent = sc.address || '';
    el.hPhone.textContent = sc.phone || '';
    el.hPhoneBox.classList.toggle('hidden', !sc.phone);
    el.tvLabel.textContent = sc.tvLabel || 'TV';
    if (themeSetting !== (sc.theme || 'auto')) { themeSetting = sc.theme || 'auto'; applyTheme(); }
    if (!sc.weatherEnabled) el.weather.classList.add('hidden');
  }

  // ---------- počasie ----------
  const W_ICON = {
    clear: (s) => `<svg role="img" aria-label="Jasno" viewBox="0 0 48 48" width="${s}" height="${s}" fill="none" stroke="#BC1A21" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="24" r="9" fill="#FFFFFF"></circle><path d="M24 6v5M24 37v5M6 24h5M37 24h5M11.3 11.3l3.5 3.5M33.2 33.2l3.5 3.5M36.7 11.3l-3.5 3.5M14.8 33.2l-3.5 3.5"></path></svg>`,
    partly: (s) => `<svg role="img" aria-label="Polooblačno" viewBox="0 0 48 48" width="${s}" height="${s}" fill="none" stroke="#BC1A21" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="7"></circle><path d="M18 5v3M18 28v3M5 18h3M28 18h3M8.8 8.8l2.1 2.1M25.1 25.1l2.1 2.1M27.2 8.8l-2.1 2.1"></path><path d="M22 38h14.5a6.5 6.5 0 0 0 .8-12.95A9 9 0 0 0 20.3 27 6 6 0 0 0 22 38z" fill="#FFFFFF" stroke="#434242"></path></svg>`,
    cloudy: (s) => `<svg role="img" aria-label="Oblačno" viewBox="0 0 48 48" width="${s}" height="${s}" fill="none" stroke="#434242" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 36h20.5a7.5 7.5 0 0 0 1-14.93A11 11 0 0 0 14.6 23.3 6.4 6.4 0 0 0 14 36z" fill="#FFFFFF"></path></svg>`,
    rain: (s) => `<svg role="img" aria-label="Dážď" viewBox="0 0 48 48" width="${s}" height="${s}" fill="none" stroke="#434242" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 30h20.5a7.5 7.5 0 0 0 1-14.93A11 11 0 0 0 14.6 17.3 6.4 6.4 0 0 0 14 30z" fill="#FFFFFF"></path><path d="M17 35l-2 6M25 35l-2 6M33 35l-2 6" stroke="#BC1A21"></path></svg>`,
    snow: (s) => `<svg role="img" aria-label="Sneženie" viewBox="0 0 48 48" width="${s}" height="${s}" fill="none" stroke="#434242" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 30h20.5a7.5 7.5 0 0 0 1-14.93A11 11 0 0 0 14.6 17.3 6.4 6.4 0 0 0 14 30z" fill="#FFFFFF"></path><path d="M16 37v4M14 39h4M24 37v4M22 39h4M32 37v4M30 39h4" stroke="#BC1A21"></path></svg>`,
    storm: (s) => `<svg role="img" aria-label="Búrka" viewBox="0 0 48 48" width="${s}" height="${s}" fill="none" stroke="#434242" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 30h20.5a7.5 7.5 0 0 0 1-14.93A11 11 0 0 0 14.6 17.3 6.4 6.4 0 0 0 14 30z" fill="#FFFFFF"></path><path d="M26 30l-4 7h5l-3 7" stroke="#BC1A21"></path></svg>`,
    fog: (s) => `<svg role="img" aria-label="Hmla" viewBox="0 0 48 48" width="${s}" height="${s}" fill="none" stroke="#434242" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 28h20.5a7.5 7.5 0 0 0 1-14.93A11 11 0 0 0 14.6 15.3 6.4 6.4 0 0 0 14 28z" fill="#FFFFFF"></path><path d="M12 35h24M16 41h16" stroke="#BC1A21"></path></svg>`,
  };
  const DAY_ABBR = ['Ne', 'Po', 'Ut', 'St', 'Št', 'Pi', 'So'];
  function renderWeather(w) {
    const ok = w && w.enabled && typeof w.temp === 'number' && state && state.screen && state.screen.weatherEnabled !== false;
    el.weather.classList.toggle('hidden', !ok);
    if (!ok) return;
    el.wIcon.innerHTML = (W_ICON[w.icon] || W_ICON.cloudy)(62);
    el.wTemp.textContent = `${w.temp} °C`;
    el.wText.textContent = [w.city, w.text].filter(Boolean).join(' · ');
    el.wDays.innerHTML = (w.days || []).map((d) => `<div class="w-day"><b>${DAY_ABBR[new Date(d.date + 'T12:00:00Z').getUTCDay()]}</b>${(W_ICON[d.icon] || W_ICON.cloudy)(34)}<span>${d.max}° <i>${d.min}°</i></span></div>`).join('');
    T.weather = w.temp;
  }
  function loadWeather() { AdNa.api('/api/display/weather').then(renderWeather).catch(() => {}); }

  // ---------- sezónne témy (základná, Vianoce) ----------
  let themeSetting = 'auto', themeOn = null;
  function currentTheme() {
    const forced = params.get('tema');
    if (forced === 'vianoce' || forced === 'christmas') return 'christmas';
    if (forced === 'zakladna') return 'default';
    if (themeSetting !== 'auto') return themeSetting;
    const p = parts(now());
    return Number(p.month) === 12 ? 'christmas' : 'default';   // Vianoce 1. – 31. 12.
  }
  function applyTheme() {
    const th = currentTheme();
    if (th === themeOn) return;
    themeOn = th;
    document.body.classList.toggle('theme-christmas', th === 'christmas');
    const xmas = th === 'christmas';
    el.bgStop0.setAttribute('stop-color', xmas ? '#7A0E14' : '#A3151B');
    el.bgStop1.setAttribute('stop-color', xmas ? '#B5171E' : '#C9242B');
    el.greeting.classList.toggle('hidden', !xmas);
    el.greetingText.textContent = xmas ? 'Pokojné Vianoce praje tím AdNa' : '';
    el.deco.innerHTML = ''; el.lights.innerHTML = '';
    if (!xmas) return;
    const flake = '<path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19M12 2l-2.5 2.5M12 2l2.5 2.5M12 22l-2.5-2.5M12 22l2.5-2.5M2 12l2.5-2.5M2 12l2.5 2.5M22 12l-2.5-2.5M22 12l-2.5 2.5"></path>';
    let h = '';
    for (let i = 0; i < 26; i++) {
      const size = 28 + ((i * 7) % 30), left = (i * 37) % 100, dur = 12 + (i % 9), delay = -((i * 3) % 14), op = [0.75, 0.87, 0.99][i % 3];
      h += `<svg class="flake" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" style="left:${left}%;animation-duration:${dur}s;animation-delay:${delay}s;opacity:${op}">${flake}</svg>`;
    }
    el.deco.innerHTML = h;
    const colors = ['#BC1A21', '#C9A227', '#FFFFFF', '#2E7D4F'];
    el.lights.innerHTML = Array.from({ length: 26 }, (_, i) => { const c = colors[i % 4]; return `<span class="bulb" style="background:${c};box-shadow:0 0 10px ${c};animation-delay:${(i * 0.37 % 2.2).toFixed(2)}s"></span>`; }).join('');
  }

  // ---------- TV zóna ----------
  function setTvSource(src) {
    if (src === tvSrc) return;
    tvSrc = src;
    const old = el.tvVideo.querySelector('iframe');
    if (old) old.remove();
    el.tvPh.classList.toggle('hidden', !!src);
    if (!src) return;
    const f = document.createElement('iframe');
    f.src = src;
    f.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
    f.referrerPolicy = 'no-referrer';
    el.tvVideo.insertBefore(f, el.tvVideo.firstChild);
  }
  /** Poloha obrazu TV v pixeloch obrazovky – podľa nej spúšťací skript (režim „okna“) umiestni okno prehrávača. */
  function publishLayout() {
    const r = el.tvVideo.getBoundingClientRect(), k = window.devicePixelRatio || 1;
    window.AdNaLayout = { tv: { x: Math.round(r.left * k), y: Math.round(r.top * k), width: Math.round(r.width * k), height: Math.round(r.height * k) } };
  }

  // ---------- mimoriadny oznam ----------
  let lastAnnId, annInit = false, annText = '';
  function renderAnnouncement(a) {
    const on = !!(a && a.text);
    annText = on ? a.text : '';
    el.ticker.classList.toggle('ann', on);
    el.tickerAnn.classList.toggle('hidden', !on);
    el.tickerLabelText.textContent = on ? 'Oznam' : 'Správy';
    el.tvAnnounce.classList.toggle('hidden', !on || callingRoomId !== null);
    const id = on ? a.id : null;
    if (on) {
      el.tvAnnText.textContent = a.text;
      el.tickerAnn.innerHTML = `<span>${esc(a.text)}</span>`;
      if (annInit && id !== lastAnnId) { chime(); T.announcements = (T.announcements || 0) + 1; }   // nový oznam ohlási signál
    }
    lastAnnId = id; annInit = true;
  }

  // ---------- vyvolanie: fronta, aby sa dve výzvy nikdy neprekrývali ----------
  const callQueue = [];
  let showing = null, callTimer = null, shownAt = 0;
  const MIN_SHOW_MS = 7000;   // keď čaká ďalšia výzva, aktuálna ostane aspoň 7 s (signál + hlásenie)
  function displayMs() { return ((state && state.ticketDisplaySeconds) || 15) * 1000; }
  function enqueueCall(call) {
    if (showing && showing.code === call.code) { showing = null; callQueue.unshift(call); return nextCall(); }   // zopakované vyvolanie hneď
    callQueue.push(call);
    if (!showing) nextCall();
    else { clearTimeout(callTimer); callTimer = setTimeout(endCall, Math.max(0, shownAt + MIN_SHOW_MS - Date.now())); }
  }
  function nextCall() {
    const call = callQueue.shift();
    if (!call) { showing = null; return; }
    showing = call; shownAt = Date.now();
    T.shown.push(call.code);
    showCall(call);
    chime();
    speakCall(call);
    T.flashes++;
    clearTimeout(callTimer);
    callTimer = setTimeout(endCall, callQueue.length ? MIN_SHOW_MS : displayMs());
  }
  function endCall() {
    if (callQueue.length) return nextCall();
    showing = null; callingRoomId = null;
    el.callCard.classList.add('hidden'); el.tvCall.classList.add('hidden');
    el.left.classList.remove('calling');
    el.tvAnnounce.classList.toggle('hidden', !annText);
    renderRooms(); renderQueue(); fitInfo();
  }
  function showCall(call) {
    callingRoomId = call.roomId ?? -1;
    const room = (state && state.rooms || []).find((r) => r.id === call.roomId) || {};
    const r = { name: call.roomName || room.name || 'ambulancia', roomName: call.roomName || room.name, direction: call.direction ?? room.direction, doctorName: call.doctorName ?? room.doctorName };
    const door = doorText(r), c = roomColor(call.roomId);
    const isLetter = /^[\p{L}]+$/u.test(call.code);
    // ľavá karta
    el.code.textContent = call.code;
    el.code.classList.toggle('long', String(call.code).length > 3);
    el.room.textContent = r.name;
    el.callSub.innerHTML = [r.doctorName ? esc(r.doctorName) : '', door ? `<strong>${esc(door)}</strong>` : ''].filter(Boolean).join(' · ');
    const hasDoc = !!r.doctorName;
    el.ccGrid.classList.toggle('no-doc', !hasDoc);
    el.callDoc.classList.toggle('hidden', !hasDoc);
    if (hasDoc) {
      el.callDocInit.textContent = initials(r.doctorName);
      setPhoto(el.callDocImg, r.doctorName);
      el.callDocCap.textContent = [shortDoc(r.doctorName), door.replace('Dvere', 'dvere').replace(' · ', ' ')].filter(Boolean).join(' · ');
      el.callPoint.className = 'cc-point ' + (ARROW[r.direction] ? r.direction : 'none');
    }
    el.callBar.classList.remove('run'); void el.callBar.offsetWidth;
    el.stage.style.setProperty('--t-call', (callQueue.length ? MIN_SHOW_MS : displayMs()) + 'ms');
    el.callBar.classList.add('run');
    el.callCard.classList.remove('hidden');
    el.left.classList.add('calling');
    // banner cez TV
    el.tvCallCode.textContent = call.code;
    el.tvCallCode.className = 'tb-code c' + c;
    el.tvCallTitle.textContent = `Pacient s ${isLetter ? 'písmenom' : 'číslom'} ${call.code}, prosíme, vstúpte`;
    el.tvCallSub.textContent = [r.name, door.replace(' · ', ' '), r.doctorName ? `${shortDoc(r.doctorName)} vás čaká` : ''].filter(Boolean).join(' · ');
    if (hasDoc) setPhoto(el.tvCallImg, r.doctorName); else el.tvCallImg.classList.add('hidden');
    el.tvAnnounce.classList.add('hidden');
    el.tvCall.classList.remove('hidden');
    el.tvCall.style.animation = 'none'; void el.tvCall.offsetWidth; el.tvCall.style.animation = '';
    renderRooms(); renderQueue();
  }

  // ---------- správy ----------
  let newsKey = '', pendingNews = null, newsUpdated = null;
  const tagClass = (t) => fold(t || '').replace(/[^a-z]/g, '');
  function renderNews(n) {
    const items = (n && n.enabled && n.items) || [];
    const key = items.map((i) => i.title).join('|');
    if (key === newsKey && items.length) return;
    newsKey = key;
    el.tickerMove.classList.remove('run');
    newsUpdated = n && n.updatedAt;
    const srcs = [...new Set(items.map((i) => i.source))];
    el.tickerSrc.textContent = items.length ? `Zdroj: ${srcs.slice(0, 3).join(', ')}${srcs.length > 3 ? ' a ďalší' : ''} · aktualizované ${newsUpdated ? clockHm(newsUpdated) : '–'}` : '';
    if (!items.length) {
      el.tickerMove.innerHTML = `<span class="tk-idle">${n && n.enabled === false ? '' : 'Správy sa načítavajú…'}</span>`;
      return;
    }
    const one = items.map((i) => `<span class="tk-item"><span class="tk-tag ${tagClass(i.tag || i.source)}">${esc(i.tag || i.source)}</span><span>${esc(i.title)}</span><span class="tk-dot"></span></span>`).join('');
    el.tickerMove.innerHTML = one + one;     // zdvojený obsah → plynulá slučka (posun o −50 %)
    const pxPerSec = 110;                    // rýchlosť v px plochy 1920 za sekundu
    el.tickerMove.style.animationDuration = Math.max(20, el.tickerMove.scrollWidth / 2 / pxPerSec) + 's';
    void el.tickerMove.offsetWidth;
    el.tickerMove.classList.add('run');
    T.newsItems = items.length;
  }
  const hmFmt = new Intl.DateTimeFormat('sk-SK', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const clockHm = (iso) => hmFmt.format(new Date(iso));
  el.tickerMove.addEventListener('animationiteration', () => { if (pendingNews) { const n = pendingNews; pendingNews = null; newsKey = ''; renderNews(n); } });
  function loadNews() {
    AdNa.api('/api/display/news').then((n) => {
      // novú sadu správ prepneme až po dobehnutí slučky, aby text neskákal
      if (el.tickerMove.classList.contains('run') && n.items && n.items.length) pendingNews = n; else renderNews(n);
    }).catch(() => {});
  }

  // ---------- stav zo servera ----------
  function render(s) {
    state = s;
    T.states++;
    if (s.serverTime) clockOffset = Date.parse(s.serverTime) - Date.now();
    renderHeader(s.screen);
    renderInfo(s.screen);
    setTvSource(s.tvSource || null);
    renderAnnouncement(s.announcement);
    el.ticker.classList.toggle('no-news', s.newsEnabled === false);
    if (soundEnabled !== !!s.soundEnabled) { soundEnabled = !!s.soundEnabled; updateSoundUi(); }
    updateVoiceUi();
    // vyvolanie vrátené späť do poradia (omyl) → výzvu hneď ukončíme
    if (showing) {
      const ids = [s.current, ...(s.recent || [])].filter(Boolean).map((x) => x.callId);
      const back = (x) => x.code === showing.code && !ids.includes(showing.callId) && !(s.rooms || []).some((r) => r.current === x.code);
      if (back(showing)) { clearTimeout(callTimer); callQueue.length = 0; endCall(); }
    }
    renderRooms();
    renderQueue();
    fitInfo();
  }
  function onCall(call) {
    if (!call || call.callId === T.lastCallId) return;
    T.lastCallId = call.callId;
    // číslo hneď zapíšeme do ambulancie (úplný stav príde o chvíľu)
    if (state && call.roomId != null) { const r = (state.rooms || []).find((x) => x.id === call.roomId); if (r) r.current = call.code; }
    enqueueCall(call);
  }

  // ---------- spojenie ----------
  let offlineTimer = null;
  function setOnline(on) {
    health.online = on;
    clearTimeout(offlineTimer);
    if (on) el.offline.classList.add('hidden');
    else offlineTimer = setTimeout(() => el.offline.classList.remove('hidden'), (Number(params.get('offline')) || 60) * 1000); // posledný stav ostáva, štítok až po 60 s
  }

  fit();
  tickClock(); setInterval(tickClock, 1000);
  applyTheme();
  loadNews(); setInterval(loadNews, 5 * 60_000);
  setInterval(loadWeather, 10 * 60_000);

  AdNa.connect('display', {
    onStatus: (s) => setOnline(s === 'online'),
    onMessage: (m) => {
      health.lastMessageAt = Date.now();
      health.ok = true;
      if (m.type === 'display.state') render(m.state);
      else if (m.type === 'call') onCall(m.call);
    },
  });
  // Prvé načítanie aj cez HTTP (rýchlejšie zobrazenie, kým sa pripojí WebSocket).
  AdNa.api('/api/display/state').then((s) => { if (!state) render(s); health.ok = true; loadWeather(); }).catch(() => {});

  // Zvuk: v aplikácii je automatické prehrávanie povolené; v prehliadači skúsime a prípadne ukážeme výzvu.
  audio();
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  setTimeout(updateSoundUi, isApp ? 1500 : 600);
})();
