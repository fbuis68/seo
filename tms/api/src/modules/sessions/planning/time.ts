/**
 * Temps du planning : instants stockés en UTC, affichage et récurrences en heure locale du site.
 * Intervalles [début, fin[ : une séance finissant à 12 h peut être suivie à 12 h.
 */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string) {
  try { formatter(tz); return true; } catch { return false; }
}

const DOW: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Date et heure locales d'un instant : { date: AAAA-MM-JJ, hm: HH:MM, dow: 1 (lundi) … 7, minutes depuis minuit }. */
export function local(instant: Date | string, tz: string) {
  const p: Record<string, string> = {};
  for (const x of formatter(tz).formatToParts(new Date(instant))) p[x.type] = x.value;
  const hm = `${p.hour}:${p.minute}`;
  return { date: `${p.year}-${p.month}-${p.day}`, hm, dow: DOW[p.weekday], minutes: Number(p.hour) * 60 + Number(p.minute), seconds: Number(p.second) };
}

/** Décalage (minutes) du fuseau à un instant. */
function offset(tz: string, ms: number) {
  const l = local(new Date(ms), tz);
  const [y, m, d] = l.date.split('-').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, Math.floor(l.minutes / 60), l.minutes % 60, l.seconds);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/**
 * Heure locale → instant UTC. Horaire inexistant (passage à l'heure d'été) ou ambigu
 * (passage à l'heure d'hiver) signalé : l'appelant exige une correction explicite.
 */
export function zoned(date: string, hm: string, tz: string): { at: Date; status: 'ok' | 'nonexistent' | 'ambiguous' } {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const offsets = [...new Set([offset(tz, guess - 86400000), offset(tz, guess), offset(tz, guess + 86400000)])];
  const hits = offsets.map((o) => guess - o * 60000).filter((ms) => { const l = local(new Date(ms), tz); return l.date === date && l.hm === hm; });
  const uniq = [...new Set(hits)].sort((a, b) => a - b);
  if (!uniq.length) return { at: new Date(guess - offset(tz, guess) * 60000), status: 'nonexistent' };
  return { at: new Date(uniq[0]), status: uniq.length > 1 ? 'ambiguous' : 'ok' };
}

export function addDays(date: string, n: number) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** Jour de semaine d'une date civile (1 = lundi). */
export function dowOf(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}
export const hmToMin = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
export const minToHm = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

/** Morceaux journaliers locaux d'un intervalle (travail de nuit : début et fin sur deux dates). */
export function dailySegments(start: Date, end: Date, tz: string) {
  const out: { date: string; from: number; to: number }[] = [];
  const a = local(start, tz); const b = local(new Date(end.getTime() - 1), tz);
  for (let day = a.date; day <= b.date; day = addDays(day, 1)) {
    out.push({ date: day, from: day === a.date ? a.minutes : 0, to: day === b.date ? local(end, tz).minutes || 1440 : 1440 });
  }
  return out;
}

export type WeeklyHours = Record<string, [string, string][]> | null | undefined;
/** Intervalle couvert par des plages hebdomadaires {"1": [["08:00","18:00"]]} ; null = aucune contrainte. */
export function withinWeekly(hours: WeeklyHours, start: Date, end: Date, tz: string) {
  if (!hours) return true;
  return dailySegments(start, end, tz).every((seg) => (hours[String(dowOf(seg.date))] ?? [])
    .some(([f, t]) => hmToMin(f) <= seg.from && (t === '24:00' ? 1440 : hmToMin(t)) >= seg.to));
}

export const fmtDay = (d: Date | string, tz: string) => { const l = local(d, tz); return `${l.date.slice(8, 10)}/${l.date.slice(5, 7)}/${l.date.slice(0, 4)}`; };
export const fmtRange = (s: Date | string, e: Date | string, tz: string) => `${fmtDay(s, tz)} ${local(s, tz).hm}–${local(e, tz).hm}`;
