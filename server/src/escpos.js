'use strict';
// Zostavenie lístka v príkazoch ESC/POS. Bez externých knižníc.

const ESC = 0x1b, GS = 0x1d;

/** Odstráni diakritiku – bezpečná predvoľba, funguje na každej ESC/POS tlačiarni. */
function stripDiacritics(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Kódová stránka CP852 (Latin-2) pre slovenské znaky – podpora závisí od modelu tlačiarne.
const CP852 = {
  'á': 0xa0, 'Á': 0xb5, 'ä': 0x84, 'Ä': 0x8e, 'č': 0x9f, 'Č': 0xac, 'ď': 0xd4, 'Ď': 0xd2,
  'é': 0x82, 'É': 0x90, 'í': 0xa1, 'Í': 0xd6, 'ĺ': 0x92, 'Ĺ': 0x91, 'ľ': 0x96, 'Ľ': 0x95,
  'ň': 0xe5, 'Ň': 0xd5, 'ó': 0xa2, 'Ó': 0xe0, 'ô': 0x93, 'Ô': 0xe2, 'ŕ': 0xea, 'Ŕ': 0xe8,
  'š': 0xe7, 'Š': 0xe6, 'ť': 0x9c, 'Ť': 0x9b, 'ú': 0xa3, 'Ú': 0xe9, 'ý': 0xec, 'Ý': 0xed,
  'ž': 0xa7, 'Ž': 0xa6,
};

function encodeText(text, encoding) {
  const out = [];
  const src = encoding === 'cp852' ? String(text) : stripDiacritics(text);
  for (const ch of src) {
    if (encoding === 'cp852' && CP852[ch] !== undefined) { out.push(CP852[ch]); continue; }
    const c = ch.codePointAt(0);
    out.push(c < 0x80 ? c : 0x3f); // '?'
  }
  return Buffer.from(out);
}

/**
 * @param {{code:string, clinicName:string, createdAt:Date, instruction:string, footer?:string,
 *          encoding:'ascii'|'cp852', codePage:number, cut:boolean, reprint?:boolean}} t
 */
function buildTicket(t) {
  const parts = [];
  const raw = (...b) => parts.push(Buffer.from(b));
  const text = (s) => parts.push(encodeText(s, t.encoding));
  const nl = (n = 1) => raw(...Array(n).fill(0x0a));

  const dt = new Intl.DateTimeFormat('sk-SK', {
    timeZone: 'Europe/Bratislava', day: 'numeric', month: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(t.createdAt);

  raw(ESC, 0x40);                       // ESC @ – inicializácia
  if (t.encoding === 'cp852') raw(ESC, 0x74, t.codePage & 0xff); // ESC t n – kódová stránka
  raw(ESC, 0x61, 1);                    // zarovnanie na stred
  raw(GS, 0x21, 0x11); raw(ESC, 0x45, 1); text(t.clinicName); nl(); // 2x, tučné
  raw(GS, 0x21, 0x00); raw(ESC, 0x45, 0);
  text('Vaše poradové číslo'); nl(2);
  raw(GS, 0x21, 0x66);                  // 7x šírka, 7x výška
  raw(ESC, 0x45, 1); text(t.code); nl(); raw(ESC, 0x45, 0);
  raw(GS, 0x21, 0x00); nl();
  text(dt); nl(2);
  raw(GS, 0x21, 0x01);                  // dvojitá výška
  text(t.instruction); nl();
  raw(GS, 0x21, 0x00);
  if (t.reprint) { nl(); text('(opakovaná tlač)'); nl(); }
  if (t.footer) { nl(); text(t.footer); nl(); }
  nl(4);
  if (t.cut) raw(GS, 0x56, 0x42, 0x00); // GS V B 0 – posun a orezanie
  return Buffer.concat(parts);
}

/** Dotazy na stav v reálnom čase: DLE EOT 2 (offline príčina), DLE EOT 4 (senzor papiera). */
const STATUS_QUERY = Buffer.from([0x10, 0x04, 0x02, 0x10, 0x04, 0x04]);

/** Vyhodnotí 2 bajty odpovede na STATUS_QUERY. */
function parseStatus(offlineByte, paperByte) {
  const problems = [];
  if (offlineByte & 0x04) problems.push('cover');       // kryt otvorený
  if (offlineByte & 0x20) problems.push('error');       // chyba tlačiarne
  if (offlineByte & 0x08) problems.push('feeding');     // posun papiera tlačidlom
  const paperOut = (paperByte & 0x60) !== 0;
  const paperNear = (paperByte & 0x0c) !== 0;
  return { paperOut, paperNear, cover: (offlineByte & 0x04) !== 0, error: (offlineByte & 0x20) !== 0, problems };
}

module.exports = { buildTicket, STATUS_QUERY, parseStatus, stripDiacritics, encodeText };
