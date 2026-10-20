import { DumpValue } from './dump';

/** Conversions des valeurs MCDF (dates et nombres stockés en varchar, booléens BIT). */
export const str = (v: DumpValue | undefined): string | null => {
  if (v == null) return null;
  const s = (Buffer.isBuffer(v) ? v.toString('utf8') : v).trim();
  return s === '' ? null : s;
};

export const bool = (v: DumpValue | undefined): boolean | null => {
  const s = str(v);
  if (s == null) return null;
  return ['1', 'true', 'y', 'o', 'oui', 'yes', 't'].includes(s.toLowerCase());
};

export const num = (v: DumpValue | undefined): number | null => {
  const s = str(v);
  if (s == null) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

export const int = (v: DumpValue | undefined): number | null => {
  const n = num(v);
  return n == null ? null : Math.round(n);
};

const pad = (n: number) => String(n).padStart(2, '0');
const valid = (y: number, m: number, d: number) => y > 1900 && y < 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31;

/**
 * Date/heure locale MCDF → { date: 'AAAA-MM-JJ', time: 'HH:MM:SS' | null }.
 * Formats acceptés : yyyyMMddHHmmss[SSS], yyyyMMddHHmm, yyyyMMdd, yyyy-MM-dd[ HH:mm[:ss]],
 * dd/MM/yyyy[ HH:mm[:ss]], et timestamp en millisecondes.
 */
export function localDateTime(v: DumpValue | undefined): { date: string; time: string | null } | null {
  const s = str(v);
  if (s == null) return null;
  let m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?\d{0,3})?$/.exec(s);
  if (m && valid(+m[1], +m[2], +m[3])) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4] ? `${m[4]}:${m[5]}:${m[6] ?? '00'}` : null };
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m && valid(+m[1], +m[2], +m[3])) return { date: `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`, time: m[4] ? `${pad(+m[4])}:${m[5]}:${m[6] ?? '00'}` : null };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2})[:h](\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m && valid(+m[3], +m[2], +m[1])) return { date: `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`, time: m[4] ? `${pad(+m[4])}:${m[5]}:${m[6] ?? '00'}` : null };
  if (/^\d{12,13}$/.test(s)) {
    const d = new Date(Number(s));
    return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 19) };
  }
  return null;
}

export const date = (v: DumpValue | undefined): string | null => localDateTime(v)?.date ?? null;

/** Heure seule : HH:mm, HHmm, HH:mm:ss, 9h30. */
export function time(v: DumpValue | undefined): string | null {
  const s = str(v);
  if (s == null) return null;
  const m = /^(\d{1,2})[:hH]?(\d{2})(?::?(\d{2}))?$/.exec(s);
  if (!m || +m[1] > 24 || +m[2] > 59) return null;
  return `${pad(+m[1])}:${m[2]}:${m[3] ?? '00'}`;
}

/** Champs personnalisés (CUSTOMIZED_ADDITION_FIELD) : JSON, sinon clé=valeur séparés par ; | ou retour ligne. */
export function customFields(v: DumpValue | undefined): Record<string, unknown> {
  const s = str(v);
  if (s == null) return {};
  try { const j = JSON.parse(s); if (j && typeof j === 'object') return Array.isArray(j) ? { values: j } : j; } catch { /* format texte */ }
  const out: Record<string, string> = {};
  for (const part of s.split(/[;|\n]/)) {
    const k = part.indexOf('=') >= 0 ? part.indexOf('=') : part.indexOf(':');
    if (k > 0) out[part.slice(0, k).trim()] = part.slice(k + 1).trim();
  }
  return Object.keys(out).length ? out : { raw: s };
}

/** Colonnes non reprises en colonne typée → jsonb `legacy` (sans secrets ni binaires). */
export function leftovers(row: Record<string, DumpValue>, used: Set<string>, secret = SECRET): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    if (used.has(k) || secret.has(k) || v == null || Buffer.isBuffer(v)) continue;
    const s = str(v);
    if (s != null && s.length <= 4000) out[k] = s;
  }
  return out;
}

/** Jamais repris : mots de passe, jetons, n° de sécurité sociale, clés d'API. */
export const SECRET = new Set(['PASSWORD', 'TOKEN', 'VITAL_CARD_NUMBER', 'VITAL_CARD_KEY', 'IT_ACCESS_TOKEN', 'B2BROUTER_API_KEY',
  'IOPOLE_SETTING', 'QONTO_SETTING', 'QONTO_PRODUCTION_SETTING', 'AZURE_SETTING', 'LICENSE', 'EMAIL_SETTING']);
