import { CANONICAL, ENTITY_ORDER, EntityType, REFS } from './canonical';
import { Issue, normalizeField } from './normalize';
import { FileMapping } from './profiles';
import { Table } from './tabular';

export interface CanonRow {
  entity: EntityType; file: string; line: number; key: string | null; data: Record<string, any>; issues: Issue[];
  action?: 'create' | 'update' | 'unchanged' | 'reject' | 'exclude'; targetId?: string | null;
}

const SEVERITY_RANK = { ok: 0, info: 1, warning: 2, fix: 3, blocking: 4 } as const;
export const severityOf = (issues: Issue[]) =>
  issues.reduce<keyof typeof SEVERITY_RANK>((acc, i) => (SEVERITY_RANK[i.severity] > SEVERITY_RANK[acc] ? i.severity : acc), 'ok');

/** Clé d'identité : identifiant source, sinon clé métier validée ; sinon aucune mise à jour automatique. */
export function identityKey(entity: EntityType, d: Record<string, any>): string | null {
  if (d.external_id) return String(d.external_id);
  switch (entity) {
    case 'client': return d.siret ? `siret:${d.siret}` : null;
    case 'program': return d.code ? `code:${d.code}` : null;
    case 'invoice': return d.number ? `number:${d.number}` : null;
    case 'enrollment': return d.session_ref && d.person_ref ? `${d.session_ref}|${d.person_ref}` : null;
    case 'attendance': return d.session_ref && d.person_ref && d.starts_at ? `${d.session_ref}|${d.person_ref}|${d.starts_at}` : null;
    case 'document': return d.path ? `path:${d.path}` : null;
    default: return null;
  }
}

/** Tables source + mapping → lignes canoniques normalisées (avec n° de ligne d'origine). */
export function buildRows(tables: Table[], mapping: FileMapping[], tz: string): CanonRow[] {
  const rows: CanonRow[] = [];
  for (const m of mapping) {
    const t = tables.find((x) => x.name === m.path);
    if (!t) continue;
    const defs = CANONICAL[m.entity];
    t.rows.forEach((src, idx) => {
      const issues: Issue[] = [];
      const data: Record<string, any> = {};
      for (const [field, def] of Object.entries(defs)) {
        const col = m.columns[field];
        if (!col) { if (def.required) issues.push({ severity: 'blocking', code: 'column_missing', field, message: `Colonne non associée : ${field}` }); continue; }
        data[field] = normalizeField(field, src[col], def, tz, issues);
      }
      rows.push({ entity: m.entity, file: m.path, line: idx + 2, key: identityKey(m.entity, data), data, issues });
    });
  }
  return rows;
}

/** Contrôles de cohérence intra-paquet, références et dépendances (dans l'ordre de résolution). */
export function validateRows(rows: CanonRow[], existing: (entity: EntityType, key: string) => boolean) {
  const byEntity = new Map<EntityType, Map<string, CanonRow>>();
  for (const e of ENTITY_ORDER) byEntity.set(e, new Map());
  const invoiceByNumber = new Map<string, CanonRow>();

  for (const entity of ENTITY_ORDER) {
    for (const r of rows.filter((x) => x.entity === entity)) {
      const idx = byEntity.get(entity)!;
      if (r.key) {
        if (idx.has(r.key)) r.issues.push({ severity: 'blocking', code: 'duplicate_in_package', message: `Identifiant en double dans le paquet : ${r.key}` });
        else idx.set(r.key, r);
      } else if (['person', 'session', 'payment'].includes(entity)) {
        r.issues.push({ severity: 'info', code: 'no_identity', message: 'Aucun identifiant source : création seulement, pas de mise à jour automatique lors d’un réimport.' });
      }
      if (entity === 'invoice' && r.data.number) invoiceByNumber.set(String(r.data.number), r);

      for (const [field, target] of Object.entries(REFS[entity] ?? {})) {
        const v = r.data[field];
        if (v == null || v === '') continue;
        let ref = byEntity.get(target)!.get(String(v));
        if (!ref && target === 'invoice') ref = invoiceByNumber.get(String(v));
        const ok = ref ? severityOf(ref.issues) !== 'blocking' && ref.action !== 'exclude' : existing(target, String(v));
        if (!ref && !ok) r.issues.push({ severity: 'blocking', code: 'reference_missing', field, message: `Référence ${target} introuvable : ${v}` });
        else if (ref && !ok) r.issues.push({ severity: 'blocking', code: 'dependency_blocked', field, message: `Dépend d'une ligne ${target} rejetée ou exclue (${ref.file} l.${ref.line})` });
      }

      if (entity === 'session' && r.data.ends_on && r.data.starts_on && r.data.ends_on < r.data.starts_on) {
        r.issues.push({ severity: 'blocking', code: 'invalid_dates', message: 'Date de fin antérieure au début.' });
      }
      if (entity === 'attendance' && r.data.starts_at && r.data.ends_at) {
        const dur = (Date.parse(r.data.ends_at) - Date.parse(r.data.starts_at)) / 60000;
        if (dur <= 0) r.issues.push({ severity: 'blocking', code: 'invalid_slot', message: 'Créneau : fin ≤ début.' });
        else if (r.data.minutes != null && r.data.minutes > dur) r.issues.push({ severity: 'fix', code: 'minutes_exceed_slot', message: `Durée effectuée (${r.data.minutes}) > durée du créneau (${dur}) : ramenée à ${dur}.` });
        const enrKey = `${r.data.session_ref}|${r.data.person_ref}`;
        const hasEnr = [...byEntity.get('enrollment')!.values()].some((e) => `${e.data.session_ref}|${e.data.person_ref}` === enrKey && severityOf(e.issues) !== 'blocking');
        if (!hasEnr && !existing('enrollment', enrKey)) r.issues.push({ severity: 'blocking', code: 'enrollment_missing', message: 'Présence sans inscription correspondante.' });
      }
      if (entity === 'invoice') {
        const { total_ht: ht, total_vat: vat, total_ttc: ttc } = r.data;
        if (ht != null && vat != null && ttc != null) {
          const diff = Math.abs(Math.round(Number(ht) * 100) + Math.round(Number(vat) * 100) - Math.round(Number(ttc) * 100));
          if (diff > 1) r.issues.push({ severity: 'blocking', code: 'totals_mismatch', message: `HT + TVA ≠ TTC (${ht} + ${vat} ≠ ${ttc})` });
        } else {
          r.issues.push({ severity: 'warning', code: 'incomplete_invoice', message: 'Totaux incomplets : facture archivée hors agrégats certifiés (BPF, CA).' });
        }
      }
      if (entity === 'program' && r.data.duration_hours == null) r.issues.push({ severity: 'warning', code: 'duration_missing', message: 'Durée absente : 1 h appliquée par défaut, à corriger.' });
    }
  }
}
