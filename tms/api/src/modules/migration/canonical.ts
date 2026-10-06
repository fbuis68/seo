/**
 * Schéma canonique commun de reprise. Tous les profils (Dendreo, Digiforma, générique, natif)
 * produisent ces objets ; l'ordre de résolution suit les dépendances (§6.2).
 */
export const ENTITY_ORDER = ['client', 'person', 'program', 'session', 'enrollment', 'attendance', 'invoice', 'payment', 'document'] as const;
export type EntityType = (typeof ENTITY_ORDER)[number];

type FieldType = 'string' | 'email' | 'date' | 'datetime' | 'decimal' | 'int' | 'bool' | 'siret' | 'enum';
export interface FieldDef { type: FieldType; required?: boolean; values?: string[] }

export const CANONICAL: Record<EntityType, Record<string, FieldDef>> = {
  client: {
    external_id: { type: 'string' }, name: { type: 'string', required: true }, kind: { type: 'enum', values: ['company', 'person'] },
    siret: { type: 'siret' }, email: { type: 'email' }, address: { type: 'string' }, postal_code: { type: 'string' }, city: { type: 'string' },
    is_funder: { type: 'bool' }, is_customer: { type: 'bool' },
  },
  person: {
    external_id: { type: 'string' }, first_name: { type: 'string', required: true }, last_name: { type: 'string', required: true },
    email: { type: 'email' }, phone: { type: 'string' }, role: { type: 'enum', values: ['learner', 'trainer', 'contact'] }, client_ref: { type: 'string' },
  },
  program: {
    external_id: { type: 'string' }, code: { type: 'string' }, title: { type: 'string', required: true }, duration_hours: { type: 'decimal' },
    modality: { type: 'enum', values: ['onsite', 'remote', 'blended'] }, objectives: { type: 'string' }, price_ht: { type: 'decimal' }, vat_rate: { type: 'decimal' },
    rncp_code: { type: 'string' },
  },
  session: {
    external_id: { type: 'string' }, program_ref: { type: 'string', required: true }, title: { type: 'string' }, kind: { type: 'enum', values: ['inter', 'intra'] },
    client_ref: { type: 'string' }, starts_on: { type: 'date', required: true }, ends_on: { type: 'date' }, capacity: { type: 'int' }, location: { type: 'string' },
    status: { type: 'enum', values: ['draft', 'planned', 'confirmed', 'in_progress', 'completed', 'cancelled'] },
  },
  enrollment: {
    external_id: { type: 'string' }, session_ref: { type: 'string', required: true }, person_ref: { type: 'string', required: true },
    client_ref: { type: 'string' }, status: { type: 'enum', values: ['provisional', 'confirmed', 'cancelled'] },
  },
  attendance: {
    external_id: { type: 'string' }, session_ref: { type: 'string', required: true }, person_ref: { type: 'string', required: true },
    starts_at: { type: 'datetime', required: true }, ends_at: { type: 'datetime', required: true },
    status: { type: 'enum', values: ['present', 'absent', 'partial'] }, minutes: { type: 'int' },
  },
  invoice: {
    external_id: { type: 'string' }, number: { type: 'string', required: true }, kind: { type: 'enum', values: ['invoice', 'deposit', 'credit_note'] },
    client_ref: { type: 'string', required: true }, session_ref: { type: 'string' }, issue_date: { type: 'date', required: true }, due_date: { type: 'date' },
    total_ht: { type: 'decimal' }, total_vat: { type: 'decimal' }, total_ttc: { type: 'decimal' }, currency: { type: 'string' }, pdf_path: { type: 'string' },
  },
  payment: {
    external_id: { type: 'string' }, client_ref: { type: 'string', required: true }, invoice_ref: { type: 'string' },
    amount: { type: 'decimal', required: true }, received_on: { type: 'date', required: true }, method: { type: 'string' }, reference: { type: 'string' },
  },
  document: {
    path: { type: 'string', required: true }, owner_type: { type: 'enum', values: ['session', 'enrollment', 'client', 'invoice'] },
    owner_ref: { type: 'string' }, kind: { type: 'string' },
  },
};

/** Références vers d'autres entités (résolution et blocage des dépendants). */
export const REFS: Partial<Record<EntityType, Record<string, EntityType>>> = {
  person: { client_ref: 'client' },
  session: { program_ref: 'program', client_ref: 'client' },
  enrollment: { session_ref: 'session', person_ref: 'person', client_ref: 'client' },
  attendance: { session_ref: 'session', person_ref: 'person' },
  invoice: { client_ref: 'client', session_ref: 'session' },
  payment: { client_ref: 'client', invoice_ref: 'invoice' },
};
