import { Tx, many } from '../../../core/db';
import { DumpTable, parseDump, rowsOf } from './dump';
import { str } from './values';

/** Tables MCDF lues par la reprise (le reste est ignoré : technique ou obsolète). */
export const MCDF_TABLES = new Set([
  'entity', 'tree', 'country', 'absence', 'vat', 'payment_type', 'function', 'contract_type', 'diploma_type', 'diploma', 'level', 'discipline', 'nature', 'family',
  'origin', 'course_type', 'activityarea', 'locality', 'logistic_type', 'cost', 'due', 'tariff', 'assessment', 'legal',
  'company', 'customer', 'actor', 'actor_company', 'actor_discipline', 'actor_diploma', 'skillful', 'training', 'training_entity', 'tariff_training', 'room',
  'convention', 'convention_contract_type', 'convention_payer', 'convention_training', 'timetable', 'actor_convention', 'commission', 'convention_attendee',
  'convention_attendee_session', 'session', 'schedule', 'schedule_room', 'actor_schedule', 'attendee_schedule', 'costs', 'invoice', 'invoice_line',
  'invoice_attendee', 'payment', 'payment_invoice', 'actor_document', 'company_document', 'convention_document', 'session_document', 'training_document',
]);

export const parseMcdf = (buf: Buffer) => parseDump(buf, { only: MCDF_TABLES });

/** Diagnostic : organismes (table entity) avec leurs volumes, pour choisir le périmètre. */
export function mcdfDiagnostic(tables: Map<string, DumpTable>) {
  const count = (name: string) => {
    const m = new Map<string, number>();
    for (const r of rowsOf(tables.get(name))) { const e = str(r.ENTITY_ID) ?? ''; m.set(e, (m.get(e) ?? 0) + 1); }
    return m;
  };
  const persons = count('actor'), sessions = count('session'), conventions = count('convention'), invoices = count('invoice');
  const tree = new Map(rowsOf(tables.get('tree')).filter((t) => str(t.TYPE_ID) === 'NTT' || !str(t.TYPE_ID)).map((t) => [str(t.ID)!, str(t.PARENT_ID)]));
  const entities = rowsOf(tables.get('entity')).map((e) => {
    const id = str(e.ID)!;
    return { id, name: str(e.NAME) ?? id, code: str(e.CODE), parentId: tree.get(id) ?? null, siret: str(e.SIRET),
      persons: persons.get(id) ?? 0, sessions: sessions.get(id) ?? 0, conventions: conventions.get(id) ?? 0, invoices: invoices.get(id) ?? 0 };
  });
  // Organismes présents dans les données mais absents de la table entity.
  for (const id of new Set([...persons.keys(), ...sessions.keys()])) if (id && !entities.some((e) => e.id === id)) {
    entities.push({ id, name: `Organisme ${id}`, code: null, parentId: null, siret: null, persons: persons.get(id) ?? 0, sessions: sessions.get(id) ?? 0, conventions: conventions.get(id) ?? 0, invoices: invoices.get(id) ?? 0 });
  }
  const missing = ['actor', 'session', 'schedule', 'convention'].filter((t) => !tables.has(t));
  const empty = [...MCDF_TABLES].filter((t) => tables.has(t) && !tables.get(t)!.rows.length);
  const warnings: string[] = [];
  if (missing.length) warnings.push(`Tables attendues absentes : ${missing.join(', ')}.`);
  if (tables.has('actor') && !tables.get('actor')!.rows.length) warnings.push('Aucune donnée : la sauvegarde ne contient que la structure (export --no-data ?).');
  if (entities.some((e) => e.parentId)) warnings.push('Organismes rattachés à un organisme parent : cochez aussi le parent si les sessions sont partagées (PARENT_ENTITY_SESSION).');
  warnings.push('Mots de passe, jetons et n° de sécurité sociale ne sont jamais repris : les utilisateurs seront invités à créer leur accès.');
  return {
    recognized: tables.has('actor') && tables.has('convention') && tables.has('schedule'),
    tables: tables.size, rows: [...tables.values()].reduce((a, t) => a + t.rows.length, 0), entities, emptyTables: empty, warnings,
  };
}

/** Ordre de suppression pour l'annulation d'un lot MCDF (dépendants d'abord). */
const ROLLBACK: [string, string, string[]][] = [
  ['document', 'documents', []],
  ['payment', 'payments', ['DELETE FROM payment_allocations WHERE payment_id = ANY($1)']],
  ['invoice_attendee', 'invoice_attendees', []],
  ['invoice_line', 'invoice_lines', []],
  ['invoice', 'invoices', ['DELETE FROM payment_allocations WHERE invoice_id = ANY($1)', 'DELETE FROM invoice_lines WHERE invoice_id = ANY($1)', 'DELETE FROM billing_items WHERE invoice_id = ANY($1)']],
  ['cost', 'session_costs', []],
  ['attendance', 'attendance', []],
  ['closure', 'closures', []],
  ['availability', 'availabilities', []],
  ['slot', 'slots', []],
  ['enrollment', 'enrollments', []],
  ['installment', 'convention_installments', []],
  ['convention_attendee', 'convention_attendees', []],
  ['convention_line', 'convention_lines', []],
  ['session', 'training_sessions', []],
  ['convention', 'conventions', ['DELETE FROM convention_payers WHERE convention_id = ANY($1)', 'DELETE FROM convention_staff WHERE convention_id = ANY($1)', 'UPDATE conventions SET template_id = NULL WHERE template_id = ANY($1)']],
  ['resource', 'resources', []],
  ['program', 'programs', ['DELETE FROM tariff_prices WHERE program_id = ANY($1)', 'DELETE FROM program_versions WHERE program_id = ANY($1)']],
  ['qualification', 'person_qualifications', []],
  ['client', 'clients', ['UPDATE persons SET employer_client_id = NULL WHERE employer_client_id = ANY($1)', 'DELETE FROM client_contacts WHERE client_id = ANY($1)']],
  ['person', 'persons', ['DELETE FROM person_roles WHERE person_id = ANY($1)', 'DELETE FROM trainer_profiles WHERE person_id = ANY($1)', 'DELETE FROM client_contacts WHERE person_id = ANY($1)']],
  ['reference', 'reference_values', ['DELETE FROM tariff_prices WHERE tariff_id = ANY($1)']],
];

export async function rollbackMcdf(tx: Tx, batchId: string) {
  const counts: Record<string, number> = {};
  const storageKeys: string[] = [];
  for (const [entity, table, pre] of ROLLBACK) {
    const ids = (await many(tx, `SELECT entity_id FROM import_changes WHERE batch_id=$1 AND entity_type=$2`, [batchId, entity])).map((x) => x.entity_id);
    if (!ids.length) continue;
    if (entity === 'document') storageKeys.push(...(await many(tx, `SELECT storage_key FROM documents WHERE id = ANY($1)`, [ids])).map((d) => d.storage_key));
    for (const q of pre) await tx.query(q, [ids]);
    const r = await tx.query(`DELETE FROM ${table} WHERE id = ANY($1)`, [ids]);
    counts[entity] = r.rowCount ?? 0;
  }
  return { counts, storageKeys };
}
