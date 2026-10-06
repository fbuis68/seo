import { isValidSiret } from '../crm/crm.service';
import { FieldDef } from './canonical';

export interface Issue { severity: 'info' | 'warning' | 'fix' | 'blocking'; code: string; field?: string; message: string }

/** Dates françaises/ISO/série Excel → AAAA-MM-JJ. */
export function normDate(v: string): string | null {
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})/.exec(s);
  if (m) return valid(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2})$/.exec(s);
  if (m) return valid(2000 + +m[3], +m[2], +m[1]);
  if (/^\d{5}(\.\d+)?$/.test(s)) { // série Excel (1900)
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400e3);
    return d.toISOString().slice(0, 10);
  }
  return null;
}
function valid(y: number, mo: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Date-heure : ISO avec fuseau, ou "JJ/MM/AAAA HH:MM" interprété dans le fuseau de l'organisme. */
export function normDateTime(v: string, tz: string): string | null {
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) return new Date(s).toISOString();
  const m = /^(.+?)[ T](\d{1,2})[:h](\d{2})/.exec(s);
  if (!m) return null;
  const d = normDate(m[1]);
  if (!d) return null;
  return zonedToUtc(d, +m[2], +m[3], tz);
}
/** Conversion heure locale (fuseau IANA) → instant UTC, gère heure d'été/hiver. */
export function zonedToUtc(date: string, h: number, min: number, tz: string): string {
  const guess = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, min);
  const offsetAt = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return new Date(t).toISOString();
}

/** "1 234,56 €" → "1234.56" ; refuse les formats ambigus. */
export function normDecimal(v: string): string | null {
  let s = v.replace(/[\s  €]/g, '').replace(/EUR$/i, '');
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  return f.length > 2 ? `${i}.${f.slice(0, 4)}` : `${i}.${(f + '00').slice(0, 2)}`;
}

const BOOL_T = ['1', 'oui', 'o', 'yes', 'y', 'true', 'vrai', 'x'];
const BOOL_F = ['0', 'non', 'n', 'no', 'false', 'faux', ''];

const ENUM_ALIASES: Record<string, string> = {
  entreprise: 'company', societe: 'company', 'société': 'company', 'personne morale': 'company', particulier: 'person', 'personne physique': 'person',
  apprenant: 'learner', stagiaire: 'learner', participant: 'learner', formateur: 'trainer', intervenant: 'trainer', contact: 'contact',
  presentiel: 'onsite', 'présentiel': 'onsite', distanciel: 'remote', 'à distance': 'remote', 'classe virtuelle': 'remote', mixte: 'blended', blended: 'blended',
  'inter-entreprise': 'inter', 'inter-entreprises': 'inter', 'intra-entreprise': 'intra',
  brouillon: 'draft', 'planifiée': 'planned', planifiee: 'planned', 'confirmée': 'confirmed', confirmee: 'confirmed', 'en cours': 'in_progress',
  'terminée': 'completed', terminee: 'completed', 'annulée': 'cancelled', annulee: 'cancelled', 'annulé': 'cancelled', annule: 'cancelled',
  provisoire: 'provisional', 'pré-inscrit': 'provisional', 'inscrit': 'confirmed', 'confirmé': 'confirmed', confirme: 'confirmed',
  'présent': 'present', present: 'present', absent: 'absent', partiel: 'partial',
  facture: 'invoice', avoir: 'credit_note', acompte: 'deposit',
};

export function normalizeField(name: string, raw: string | undefined, def: FieldDef, tz: string, issues: Issue[]): unknown {
  const v = (raw ?? '').trim();
  if (!v) {
    if (def.required) issues.push({ severity: 'blocking', code: 'required', field: name, message: `Champ obligatoire manquant : ${name}` });
    return null;
  }
  const bad = (msg: string) => { issues.push({ severity: def.required ? 'blocking' : 'fix', code: 'invalid_format', field: name, message: msg }); return null; };
  switch (def.type) {
    case 'string': return v.slice(0, 2000);
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v.toLowerCase() : bad(`Email invalide : ${v}`);
    case 'date': return normDate(v) ?? bad(`Date invalide : ${v}`);
    case 'datetime': return normDateTime(v, tz) ?? bad(`Date-heure invalide : ${v}`);
    case 'decimal': return normDecimal(v) ?? bad(`Montant/nombre invalide : ${v}`);
    case 'int': return /^\d+$/.test(v) ? Number(v) : bad(`Entier invalide : ${v}`);
    case 'bool': return BOOL_T.includes(v.toLowerCase()) ? true : BOOL_F.includes(v.toLowerCase()) ? false : bad(`Booléen invalide : ${v}`);
    case 'siret': {
      const s = v.replace(/\s/g, '');
      if (!isValidSiret(s)) { issues.push({ severity: 'warning', code: 'invalid_siret', field: name, message: `SIRET invalide ignoré : ${v}` }); return null; }
      return s;
    }
    case 'enum': {
      const k = v.toLowerCase();
      const mapped = def.values!.includes(k) ? k : ENUM_ALIASES[k];
      if (mapped && def.values!.includes(mapped)) return mapped;
      issues.push({ severity: 'warning', code: 'unknown_value', field: name, message: `Valeur non reconnue « ${v} » : valeur par défaut appliquée` });
      return null;
    }
  }
}
