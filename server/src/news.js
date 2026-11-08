'use strict';
// v2 – informačná lišta: server sťahuje RSS/Atom kanály médií a obrazovke posiela len titulky so zdrojom.
// Obrazovka nikdy nesťahuje cudzie stránky sama (žiadne CORS problémy, žiadne sledovanie pacientov tretími stranami).
const log = require('./log');

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»' };

function decode(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}
function tag(block, names) {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'));
    if (m) return m[1];
  }
  return null;
}

/** Jednoduchý parser RSS 2.0 / Atom – stačí titulok a dátum. */
function parseFeed(xml) {
  const blocks = String(xml).match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const out = [];
  for (const b of blocks) {
    const title = decode(tag(b, ['title']) || '');
    if (!title || title.length < 8) continue;
    const d = tag(b, ['pubDate', 'published', 'updated', 'dc:date']);
    const at = d ? Date.parse(decode(d)) : NaN;
    out.push({ title: title.length > 180 ? title.slice(0, 177) + '…' : title, at: Number.isFinite(at) ? at : null });
  }
  return out;
}

class News {
  /** @param {() => any} getSettings @param {{fetch?: typeof fetch, now?: () => number}} [opt] */
  constructor(getSettings, opt = {}) {
    this.getSettings = getSettings;
    this.fetch = opt.fetch || globalThis.fetch;
    this.now = opt.now || Date.now;
    this.cache = new Map();   // url -> { items, okAt, error, checkedAt }
    this.items = [];
    this.updatedAt = null;
    this.timer = null;
    this.running = null;
  }

  start() {
    const loop = async () => {
      await this.refresh().catch(() => {});
      const min = this.getSettings().news.refreshMinutes || 10;
      this.timer = setTimeout(loop, min * 60_000);
      this.timer.unref?.();
    };
    loop();
  }
  stop() { clearTimeout(this.timer); }

  async fetchOne(feed) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await this.fetch(feed.url, { signal: ctrl.signal, headers: { 'User-Agent': 'AdNa-cakaren/2.0 (RSS)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const items = parseFeed(text.slice(0, 2_000_000));
      if (!items.length) throw new Error('kanál neobsahuje žiadne správy');
      this.cache.set(feed.url, { items, okAt: this.now(), error: null, checkedAt: this.now() });
    } catch (e) {
      const prev = this.cache.get(feed.url) || { items: [], okAt: null };
      this.cache.set(feed.url, { ...prev, error: ctrl.signal.aborted ? 'časový limit' : String(e.message || e), checkedAt: this.now() });
      log.warn('Správy: zdroj nedostupný', { feed: feed.name, err: String(e.message || e).slice(0, 200) });
    } finally { clearTimeout(t); }
  }

  async refresh() {
    if (this.running) return this.running;
    this.running = (async () => {
      const s = this.getSettings().news;
      if (!s.enabled) { this.items = []; return; }
      await Promise.all(s.feeds.map((f) => this.fetchOne(f)));
      this.items = this.compose(s);
      this.updatedAt = new Date(this.now()).toISOString();
    })().finally(() => { this.running = null; });
    return this.running;
  }

  /** Vyberie najnovšie titulky, vyradí nevhodné témy a duplicity a zdroje strieda, aby lišta nebola len z jedného média. */
  compose(s) {
    const minAt = this.now() - s.maxAgeHours * 3600_000;
    const bad = (s.exclude || []).map((w) => w.toLowerCase()).filter(Boolean);
    const seen = new Set();
    const perFeed = s.feeds.map((f) => {
      const c = this.cache.get(f.url);
      if (!c) return [];
      return c.items
        .filter((i) => i.at == null || i.at >= minAt)
        .filter((i) => !bad.some((w) => i.title.toLowerCase().includes(w)))
        .sort((a, b) => (b.at || 0) - (a.at || 0))
        .slice(0, 6)
        .map((i) => ({ title: i.title, source: f.name, tag: f.tag || '', at: i.at ? new Date(i.at).toISOString() : null }));
    });
    const out = [];
    for (let round = 0; round < 6; round++) {
      for (const list of perFeed) {
        const i = list[round];
        if (!i) continue;
        const key = i.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(i);
      }
    }
    return out.slice(0, 40);
  }

  publicState() {
    return { enabled: this.getSettings().news.enabled, updatedAt: this.updatedAt, items: this.items };
  }

  status() {
    return this.getSettings().news.feeds.map((f) => {
      const c = this.cache.get(f.url) || {};
      return { name: f.name, url: f.url, ok: !c.error && !!c.okAt, items: (c.items || []).length,
        lastOkAt: c.okAt ? new Date(c.okAt).toISOString() : null, error: c.error || null };
    });
  }
}

module.exports = { News, parseFeed, decode };
