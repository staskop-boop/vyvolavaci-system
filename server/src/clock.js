'use strict';
// Hodiny s možnosťou posunu – používajú to iba testy (simulácia zmeny dňa).
let offsetMs = Number(process.env.ADNA_TEST_TIME_OFFSET_MS || 0);

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Bratislava', year: 'numeric', month: '2-digit', day: '2-digit',
});

function now() { return new Date(Date.now() + offsetMs); }
function nowIso() { return now().toISOString(); }
/** Deň vo formáte YYYY-MM-DD podľa pásma Europe/Bratislava. */
function dayOf(date) { return dayFmt.format(date); }
function today() { return dayOf(now()); }
const partFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Bratislava', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function wallMs(date) {
  const p = Object.fromEntries(partFmt.formatToParts(date).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
}
/** Čas „HH:MM“ v daný deň (Europe/Bratislava) → ISO v UTC. */
function localToIso(day, hm) {
  const [y, m, d] = day.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  const target = Date.UTC(y, m - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 3; i++) guess += target - wallMs(new Date(guess));
  return new Date(guess).toISOString();
}
function setOffset(ms) { offsetMs = ms; }

module.exports = { now, nowIso, dayOf, today, setOffset, localToIso };
