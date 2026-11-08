'use strict';
// v3 – počasie do hlavičky obrazovky: Open-Meteo (bez kľúča). Sťahuje server (obrazovka nikdy nevolá cudzie adresy),
// obnova každých 15 min, pri výpadku ostáva posledný známy stav.
const log = require('./log');

/** WMO weather_code → ikona + slovenský popis (podľa dizajnového manuálu). */
function wmo(code) {
  const c = Number(code);
  if (c === 0) return { icon: 'clear', text: 'Jasno' };
  if (c === 1 || c === 2) return { icon: 'partly', text: 'Polooblačno' };
  if (c === 3) return { icon: 'cloudy', text: 'Oblačno' };
  if (c === 45 || c === 48) return { icon: 'fog', text: 'Hmla' };
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return { icon: 'rain', text: 'Dážď' };
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { icon: 'snow', text: 'Sneženie' };
  if (c >= 95 && c <= 99) return { icon: 'storm', text: 'Búrka' };
  return { icon: 'cloudy', text: 'Oblačno' };
}

function parse(j) {
  const cur = j && j.current, d = j && j.daily;
  if (!cur || !d || !Array.isArray(d.time)) throw new Error('neočakávaná odpoveď');
  const days = d.time.slice(1, 4).map((date, i) => ({
    date, ...wmo(d.weather_code[i + 1]),
    max: Math.round(d.temperature_2m_max[i + 1]), min: Math.round(d.temperature_2m_min[i + 1]),
  }));
  return { temp: Math.round(cur.temperature_2m), ...wmo(cur.weather_code), days };
}

class Weather {
  constructor(getSettings, opt = {}) {
    this.getSettings = getSettings;
    this.fetch = opt.fetch || globalThis.fetch;
    this.now = opt.now || Date.now;
    this.data = null; this.updatedAt = null; this.error = null; this.timer = null;
  }
  cfg() { return this.getSettings().screen.weather; }
  url(w) {
    return `https://api.open-meteo.com/v1/forecast?latitude=${w.lat}&longitude=${w.lon}&current=temperature_2m,weather_code`
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Europe%2FBratislava&forecast_days=4';
  }
  async refresh() {
    const w = this.cfg();
    if (!w.enabled) { this.data = null; return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await this.fetch(this.url(w), { signal: ctrl.signal, headers: { 'User-Agent': 'AdNa-cakaren/3.0' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      this.data = parse(await res.json());
      this.updatedAt = new Date(this.now()).toISOString(); this.error = null;
    } catch (e) {
      this.error = ctrl.signal.aborted ? 'časový limit' : String(e.message || e);
      log.warn('Počasie: nedostupné', { err: this.error.slice(0, 200) });
    } finally { clearTimeout(t); }
  }
  start() {
    const loop = async () => { await this.refresh().catch(() => {}); this.timer = setTimeout(loop, 15 * 60_000); this.timer.unref?.(); };
    loop();
  }
  stop() { clearTimeout(this.timer); }
  publicState() {
    const w = this.cfg();
    return { enabled: !!w.enabled, city: w.city, updatedAt: this.updatedAt, ...(w.enabled && this.data ? this.data : {}) };
  }
}

module.exports = { Weather, wmo, parse };
