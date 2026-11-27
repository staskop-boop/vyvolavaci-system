'use strict';
/**
 * Malý generátor PDF bez závislostí – len na SKÚŠOBNÚ stránku a na SIMULOVANÝ doklad.
 * Skutočný doklad sa nikdy negeneruje tu: v ostrom režime sa tlačí originálny výstup z VRP2 (PDF s QR kódom).
 * Písmo Helvetica (WinAnsi) – znaky mimo WinAnsi (č, š, ž, ť, ľ, ň, ď, ĺ, ŕ…) sa prepíšu bez mäkčeňa.
 */
const MM = 72 / 25.4;
const WINANSI_OK = /[\x20-\x7e -ÿ]/;

function toWinAnsi(s) {
  let out = '';
  for (const ch of String(s)) {
    if (WINANSI_OK.test(ch)) out += ch;
    else if (ch === '€') out += '\x80';
    else if (ch === '–' || ch === '—') out += '-';
    else if (ch === '·') out += '\xb7';
    else { const b = ch.normalize('NFD').replace(/[̀-ͯ]/g, ''); out += WINANSI_OK.test(b) ? b : '?'; }
  }
  return out.replace(/[\\()]/g, (m) => '\\' + m);
}

/**
 * @param {{text:string, size?:number, bold?:boolean}[]} lines
 * @param {{widthMm?:number}} opt  predvolene 80 mm (pokladničný papier); 58 mm alebo A4 (210) podľa tlačiarne
 * @returns {Buffer}
 */
function textPdf(lines, { widthMm = 80 } = {}) {
  const W = widthMm * MM, margin = 4 * MM;
  let y = 0;
  const ops = [];
  const lh = (sz) => sz * 1.35;
  const total = lines.reduce((a, l) => a + lh(l.size || 9), 0);
  const H = Math.max(60 * MM, total + 2 * margin);
  y = H - margin;
  for (const l of lines) {
    const sz = l.size || 9;
    y -= lh(sz);
    ops.push(`BT /${l.bold ? 'F2' : 'F1'} ${sz} Tf ${margin.toFixed(2)} ${y.toFixed(2)} Td (${toWinAnsi(l.text)}) Tj ET`);
  }
  const content = Buffer.from(ops.join('\n'), 'latin1');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W.toFixed(2)} ${H.toFixed(2)}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    null,
  ];
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let len = parts[0].length;
  objs.forEach((o, i) => {
    const b = o == null
      ? Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${content.length} >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream\nendobj\n', 'latin1')])
      : Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
    offsets.push(len); parts.push(b); len += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

function testPage({ agentName, printerName, registerLabel, companyName, widthMm }) {
  const now = new Date().toLocaleString('sk-SK', { timeZone: 'Europe/Bratislava' });
  return textPdf([
    { text: 'SKÚŠOBNÁ TLAČ', size: 14, bold: true },
    { text: 'NIE JE TO POKLADNIČNÝ DOKLAD', size: 10, bold: true },
    { text: 'Nevznikla žiadna tržba.', size: 9 },
    { text: ' ' },
    { text: `Spoločnosť: ${companyName || '–'}` },
    { text: `Pokladnica: ${registerLabel || '–'}` },
    { text: `Agent: ${agentName || '–'}` },
    { text: `Tlačiareň: ${printerName || '–'}` },
    { text: `Čas: ${now}` },
    { text: ' ' },
    { text: '1234567890 ÁÄÉÍÓÔÚÝ áäéíóôúý €', size: 8 },
    { text: '---------------------------------------', size: 8 },
  ], { widthMm });
}

module.exports = { textPdf, testPage, toWinAnsi };
