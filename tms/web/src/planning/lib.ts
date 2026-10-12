import { zonedIso } from '../api';

/** Heures du planning affichées dans le fuseau du centre (jamais celui du navigateur). */
const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = cache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }); cache.set(tz, f); }
  return f;
}
const DOW: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
export function parts(d: Date | string, tz: string) {
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(new Date(d))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, minutes: Number(p.hour) * 60 + Number(p.minute), dow: DOW[p.weekday] };
}
export const addDays = (date: string, n: number) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
export const dowOf = (date: string) => { const [y, m, d] = date.split('-').map(Number); return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1; };
export const mondayOf = (date: string) => addDays(date, -(dowOf(date) - 1));
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
export const hmToMin = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
export const minToHm = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
export const at = (date: string, hm: string, tz: string) => zonedIso(date, hm, tz);
export const today = (tz: string) => parts(new Date(), tz).date;
export const fmtH = (m: number) => `${Math.floor(m / 60)} h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;
const DAY_NAMES = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
export const dayLabel = (date: string) => `${DAY_NAMES[dowOf(date) - 1]} ${date.slice(8, 10)}/${date.slice(5, 7)}`;
export const longDay = (date: string) => `${DAY_NAMES[dowOf(date) - 1]} ${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
export const monthLabel = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;

export type View = 'day' | 'week' | 'month' | 'timeline' | 'list';
export type Zoom = 'day' | 'week' | 'month';
export type GroupBy = 'trainer' | 'room' | 'equipment' | 'site' | 'session' | 'group' | 'learner';

/** Période chargée pour une vue ; changer de vue ou de zoom conserve la date d'ancrage. */
export function rangeOf(view: View, zoom: Zoom, date: string): { start: string; days: number } {
  if (view === 'day' || (view === 'timeline' && zoom === 'day')) return { start: date, days: 1 };
  if (view === 'week' || view === 'list' || (view === 'timeline' && zoom === 'week')) return { start: mondayOf(date), days: 7 };
  const first = `${date.slice(0, 8)}01`;
  const nextMonth = addDays(first, 32).slice(0, 8) + '01';
  if (view === 'timeline') return { start: first, days: daysBetween(first, nextMonth) };
  const start = mondayOf(first);
  return { start, days: Math.ceil((daysBetween(start, nextMonth)) / 7) * 7 };
}
export function step(view: View, zoom: Zoom, date: string, dir: 1 | -1) {
  if (view === 'day' || (view === 'timeline' && zoom === 'day')) return addDays(date, dir);
  if (view === 'week' || view === 'list' || (view === 'timeline' && zoom === 'week')) return addDays(date, 7 * dir);
  const first = `${date.slice(0, 8)}01`;
  return dir > 0 ? addDays(first, 32).slice(0, 8) + '01' : addDays(first, -1).slice(0, 8) + '01';
}

export const STATUS: Record<string, { label: string; mark: string }> = {
  draft: { label: 'Brouillon', mark: '✎' }, pending: { label: 'À valider', mark: '◷' }, published: { label: 'Publié', mark: '✓' },
  done: { label: 'Réalisé', mark: '■' }, cancelled: { label: 'Annulé', mark: '✕' },
};
export const MODALITY: Record<string, string> = { onsite: 'Présentiel', remote: 'Distanciel', hybrid: 'Hybride' };

const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c7)', 'var(--c8)', 'var(--c6)'];
const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
export type ColorBy = 'session' | 'program' | 'status';
const STATUS_COLOR: Record<string, string> = { draft: 'var(--c6)', pending: 'var(--c5)', published: 'var(--c1)', done: 'var(--c3)', cancelled: 'var(--err)' };
export function colorOf(s: any, by: ColorBy) {
  if (by === 'status') return STATUS_COLOR[s.status];
  if (by === 'session' && s.session_color) return s.session_color;
  const key = by === 'program' ? s.program_id : s.session_id;
  return PALETTE[hash(key ?? '') % PALETTE.length];
}
export function legendOf(items: any[], by: ColorBy): [string, string][] {
  if (by === 'status') return Object.entries(STATUS).map(([k, v]) => [v.label, STATUS_COLOR[k]]);
  const seen = new Map<string, string>();
  for (const s of items) { const label = by === 'program' ? s.program_title : s.session_title + (s.session_reference ? ` (${s.session_reference})` : ''); if (!seen.has(label)) seen.set(label, colorOf(s, by)); }
  return [...seen.entries()];
}

/** Lignes / colonnes d'un regroupement : une séance apparaît dans chaque ressource concernée. */
export function keysOf(s: any, by: GroupBy): string[] {
  const res = (kind: string) => s.resources.filter((r: any) => r.kind === kind).map((r: any) => r.id);
  const k = by === 'trainer' ? s.trainers.map((t: any) => t.id) : by === 'room' ? res('room') : by === 'equipment' ? res('equipment')
    : by === 'site' ? (s.site_id ? [s.site_id] : []) : by === 'session' ? [s.session_id] : by === 'group' ? [s.group_label ?? '__all'] : (s.learners ?? []).map((l: any) => l.id);
  return k.length ? k : ['__none'];
}
export function rowsOf(by: GroupBy, lk: any, items: any[]): { id: string; label: string; sub?: string }[] {
  const rows = by === 'trainer' ? lk.trainers.map((t: any) => ({ id: t.id, label: t.name, sub: t.status === 'external' ? 'externe' : undefined }))
    : ['room', 'equipment', 'site'].includes(by) ? lk.resources.filter((r: any) => r.kind === by).map((r: any) => ({ id: r.id, label: r.name, sub: r.capacity ? `${r.capacity} pl.` : r.category ?? undefined }))
    : by === 'session' ? [...new Map(items.map((s) => [s.session_id, { id: s.session_id, label: s.session_title, sub: s.session_reference ?? undefined }])).values()]
    : by === 'group' ? [...new Set(items.map((s) => s.group_label ?? '__all'))].map((g) => ({ id: g, label: g === '__all' ? 'Tous groupes' : g }))
    : [...new Map(items.flatMap((s) => s.learners ?? []).map((l: any) => [l.id, { id: l.id, label: l.name }])).values()].sort((a: any, b: any) => a.label.localeCompare(b.label));
  if (items.some((s) => keysOf(s, by).includes('__none'))) rows.push({ id: '__none', label: by === 'trainer' ? 'Sans formateur' : by === 'learner' ? 'Sans participant' : 'Non affecté' });
  return rows;
}
export const GROUP_LABEL: Record<GroupBy, string> = { trainer: 'Formateur', room: 'Salle', equipment: 'Matériel', site: 'Site', session: 'Session', group: 'Groupe', learner: 'Stagiaire' };

/** Couloirs pour empiler les chevauchements (jamais masqués). */
export function lanes<T extends { s: number; e: number }>(list: T[]): (T & { lane: number; lanes: number })[] {
  const sorted = [...list].sort((a, b) => a.s - b.s || b.e - a.e);
  const out: (T & { lane: number; lanes: number })[] = [];
  let cluster: (T & { lane: number; lanes: number })[] = []; let clusterEnd = -Infinity; let ends: number[] = [];
  const flush = () => { const n = Math.max(1, ...cluster.map((c) => c.lane + 1)); for (const c of cluster) c.lanes = n; cluster = []; ends = []; };
  for (const it of sorted) {
    if (it.s >= clusterEnd) { flush(); clusterEnd = -Infinity; }
    let lane = ends.findIndex((e) => e <= it.s);
    if (lane < 0) { lane = ends.length; ends.push(it.e); } else ends[lane] = it.e;
    const x = { ...it, lane, lanes: 1 }; cluster.push(x); out.push(x);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  flush();
  return out;
}

/** Préférences mémorisées par utilisateur (vue, filtres, plages, densité, favoris). */
export function loadPrefs<T>(key: string, def: T): T {
  try { return { ...def, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return def; }
}
export function savePrefs(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* stockage indisponible */ } }
