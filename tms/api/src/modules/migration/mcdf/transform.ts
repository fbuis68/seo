import { Tx, many } from '../../../core/db';
import { DumpTable, DumpValue, rowsOf } from './dump';
import { bool, customFields, date, int, leftovers, localDateTime, num, str, time } from './values';
import { Col, McdfWriter } from './writer';

type Row = Record<string, DumpValue>;

/** Référentiels MCDF → reference_values (kind = nom de table). */
const REF_TABLES: Record<string, (r: Row) => Record<string, unknown>> = {
  absence: (r) => ({ billable: bool(r.BILLABLE) }),
  vat: (r) => ({ rate: num(r.RATE), account: str(r.ACCOUNT_ACCOUNTING) }),
  payment_type: () => ({}),
  function: (r) => ({ function: str(r.FUNCTION), decision_maker: bool(r.DECISION_MAKER), invoice_receipt: bool(r.INVOICE_RECEIPT) }),
  contract_type: (r) => ({ bpf: str(r.BPF) }),
  diploma_type: () => ({}),
  diploma: (r) => ({ diploma_type: str(r.DIPLOMA_TYPE_ID), training: str(r.TRAINING), bpf_level: str(r.BPF_LEVEL), download: bool(r.DOWNLOAD) }),
  level: (r) => ({ level: str(r.LEVEL), mark: num(r.MARK), color: str(r.COLOR) }),
  discipline: (r) => ({ discipline: bool(r.DISCIPLINE) }),
  nature: () => ({}),
  family: () => ({}),
  origin: () => ({}),
  course_type: (r) => ({ course: str(r.COURSE) }),
  activityarea: () => ({}),
  locality: () => ({}),
  logistic_type: () => ({}),
  cost: (r) => ({ billable: bool(r.BILLABLE) }),
  due: (r) => ({ period: int(r.PERIOD), day: int(r.DAY) }),
  tariff: (r) => ({ type: str(r.TYPE) }),
  assessment: () => ({}),
  legal: () => ({}),
};

export interface McdfOptions { entityIds: string[]; timezone: string; today: string; dryRun: boolean }
export interface McdfDocument { table: string; legacyId: string; ownerType: string; ownerId: string | null; kind: string; name: string; data: Buffer; signed: boolean | null }

/**
 * Reprise MCDF → TMS dans la transaction fournie (RLS : organisme courant).
 * Chaque objet MCDF garde son identifiant (legacy_id) ; un objet déjà repris est reconnu et laissé
 * inchangé : rejouer la même sauvegarde (ou une plus récente) n'ajoute que les nouveautés.
 */
export async function runMcdf(tx: Tx, w: McdfWriter, tables: Map<string, DumpTable>, o: McdfOptions) {
  const ents = new Set(o.entityIds);
  const cache = new Map<string, Row[]>();
  const T = (name: string) => { let r = cache.get(name); if (!r) { r = rowsOf(tables.get(name)); cache.set(name, r); tables.get(name) && (tables.get(name)!.rows = []); } return r; };
  const mine = (r: Row) => r.ENTITY_ID == null || ents.has(String(r.ENTITY_ID));
  const local = (r: Row) => r.ENTITY_ID != null && ents.has(String(r.ENTITY_ID));
  const docs: McdfDocument[] = [];
  const tz = o.timezone.replace(/'/g, '');
  const ts: Col = { name: 'starts_at', expr: (p) => `(${p}::timestamp AT TIME ZONE '${tz}')` };
  const te: Col = { name: 'ends_at', expr: (p) => `(${p}::timestamp AT TIME ZONE '${tz}')` };

  /** Objets déjà repris : legacy_id → uuid, par table cible. */
  const known = async (table: string, extra = '') => new Map(
    (await many(tx, `SELECT legacy_id, id FROM ${table} WHERE legacy_id IS NOT NULL ${extra}`)).map((x) => [x.legacy_id as string, x.id as string]));

  const countries = new Map(T('country').map((c) => [str(c.ID)!, str(c.CODE) ?? str(c.NAME)]));
  const country = (v: DumpValue) => (v == null ? null : countries.get(String(v)) ?? str(v));
  const address = (r: Row, p = '') => {
    const a = { line1: str(r[`${p}ADDRESS`]) ?? '', line2: str(r[`${p}ADDRESS2`]) ?? '', line3: str(r[`${p}ADDRESS3`]) ?? '',
      postal_code: str(r[`${p}POSTAL_CODE`] ?? r[`${p}POSTALCODE`]) ?? '', city: str(r[`${p}CITY`]) ?? '', country: country(r[`${p}COUNTRY_ID`]) ?? '' };
    return Object.fromEntries(Object.entries(a).filter(([, v]) => v !== ''));
  };

  // ─── 1. Référentiels ──────────────────────────────────────────────────────
  const refs = new Map<string, string>(); // kind:legacy → uuid
  for (const x of await many(tx, `SELECT kind, legacy_id, id FROM reference_values WHERE legacy_id IS NOT NULL`)) refs.set(`${x.kind}:${x.legacy_id}`, x.id);
  const ref = (kind: string, v: DumpValue) => (v == null ? null : refs.get(`${kind}:${v}`) ?? null);
  for (const [kind, data] of Object.entries(REF_TABLES)) {
    for (const r of T(kind).filter(mine)) {
      const id = str(r.ID); if (!id) continue;
      w.read('reference');
      if (refs.has(`${kind}:${id}`)) { w.unchanged('reference'); continue; }
      const uuid = w.newId();
      refs.set(`${kind}:${id}`, uuid);
      w.add('reference', 'reference_values', ['id', 'tenant_id', 'kind', 'code', 'label', 'data', 'active', 'legacy_id'],
        [uuid, w.tenantId, kind, str(r.CODE), str(r.NAME) ?? str(r.CODE) ?? id, JSON.stringify(data(r)), bool(r.ACTIVATED) !== false, id], { id: uuid, legacyId: `${kind}:${id}` });
    }
  }
  await w.flush();
  const vatRate = new Map(T('vat').map((v) => [str(v.ID)!, num(v.RATE)]));
  const paymentType = new Map(T('payment_type').map((p) => [str(p.ID)!, str(p.CODE) ?? str(p.NAME)]));

  // ─── 2. Entreprises et financeurs (company) ───────────────────────────────
  const clients = await known('clients');
  const companyRows = T('company').filter(local);
  const customers = T('customer').filter(local);
  const billedCompanies = new Set<string>([
    ...customers.map((c) => str(c.COMPANY_ID)).filter(Boolean) as string[],
    ...T('invoice').filter(local).map((i) => str(i.PAYER_ID)).filter(Boolean) as string[],
  ]);
  for (const r of companyRows) {
    const id = str(r.ID)!;
    w.read('client');
    if (clients.has(id)) { w.unchanged('client'); continue; }
    const uuid = w.newId();
    clients.set(id, uuid);
    const siret = str(r.SIRET)?.replace(/\s/g, '') ?? null;
    w.add('client', 'clients', ['id', 'tenant_id', 'kind', 'status', 'is_funder', 'name', 'siren', 'siret', 'billing_email', 'billing_address', 'archived_at',
      'legacy_id', 'code', 'phone', 'fax', 'website', 'ape', 'vat_number', 'staff_count', 'capital', 'activity_area_id', 'origin_id', 'payment_method', 'payment_terms',
      'accounting_account', 'third_party_code', 'iban', 'bic', 'bank', 'tariff_id', 'is_asp', 'min_invoice', 'notes', 'custom_fields', 'legacy', 'created_at'],
    [uuid, w.tenantId, 'company', billedCompanies.has(id) ? 'customer' : 'prospect', !!bool(r.FINANCER), str(r.NAME) ?? `Entreprise ${id}`,
      siret && /^\d{14}$/.test(siret) ? siret.slice(0, 9) : null, siret, str(r.EMAIL), JSON.stringify(address(r)), bool(r.ACTIVATED) === false ? new Date().toISOString() : null,
      id, str(r.CODE), str(r.PHONE), str(r.FAX), str(r.WEBSITE), str(r.APE), str(r.INTRA_COMMUNITY_VAT), int(r.STAFF_COUNT), num(r.CAPITAL),
      ref('activityarea', r.ACTIVITYAREA_ID), ref('origin', r.ORIGIN_ID), paymentType.get(str(r.PAYMENT_TYPE_ID) ?? '') ?? null,
      JSON.stringify({ period: int(r.PAYMENT_PERIOD), day: int(r.PAYMENT_DAY), label: str(r.PAYMENT_LABEL), due: str(r.DUE_ID) }),
      str(r.ACCOUNT_ACCOUNTING), str(r.THIRD), str(r.IBAN), str(r.BIC), str(r.BANK), ref('tariff', r.TARIFF_ID), !!bool(r.ASP),
      JSON.stringify({ hours: num(r.INVOICE_HOURS_MINI), amount: num(r.INVOICE_AMOUNT_MINI) }), str(r.NOTES), JSON.stringify(customFields(r.CUSTOMIZED_ADDITION_FIELD)),
      JSON.stringify(leftovers(r, USED.company)), createdAt(r)], { id: uuid, legacyId: id });
  }
  await w.flush();

  // ─── 3. Personnes (actor) ─────────────────────────────────────────────────
  const persons = await known('persons');
  const actors = T('actor').filter(local);
  for (const r of actors) if (!persons.has(str(r.ID)!)) persons.set(str(r.ID)!, w.newId());
  const pref = (v: DumpValue) => (v == null ? null : persons.get(String(v)) ?? null);
  const existingPersons = new Set((await known('persons')).keys());
  const trainers: Row[] = [];
  for (const r of actors) {
    const id = str(r.ID)!;
    w.read('person');
    if (existingPersons.has(id)) { w.unchanged('person'); continue; }
    const uuid = persons.get(id)!;
    const roles = new Set<string>();
    if (bool(r.ATTENDEE) || bool(r.CANDIDATE)) roles.add('learner');
    if (bool(r.TRAINER)) roles.add('trainer');
    if (bool(r.CONTACT)) roles.add('contact');
    if (bool(r.TUTOR)) roles.add('tutor');
    if (bool(r.ACCOUNT_MANAGER) || bool(r.MANAGER)) roles.add('staff');
    if (!roles.size) roles.add(bool(r.CUSTOMER) ? 'learner' : 'contact');
    const archived = bool(r.ARCHIVED) || bool(r.ACTIVATED) === false;
    w.add('person', 'persons', ['id', 'tenant_id', 'first_name', 'last_name', 'email', 'phone', 'archived_at', 'legacy_id', 'code', 'civility', 'gender', 'maiden_name',
      'birth_date', 'birth_place', 'birth_country', 'nationality', 'mobile', 'email2', 'address', 'employer_client_id', 'job_title', 'function_id', 'level_id', 'diploma_id',
      'origin_id', 'tutor_person_id', 'account_manager_person_id', 'manager_person_id', 'is_candidate', 'is_minor', 'no_messages', 'color', 'notes', 'custom_fields', 'legacy', 'created_at'],
    [uuid, w.tenantId, str(r.FIRSTNAME) ?? '', str(r.LASTNAME) ?? str(r.LOGIN) ?? `Personne ${id}`, str(r.EMAIL), str(r.FIXED_PHONE), archived ? new Date().toISOString() : null,
      id, str(r.CODE), str(r.CIVILITY), str(r.SEXE), str(r.MAIDEN_NAME), date(r.BIRTH_DATE), str(r.BIRTH_PLACE), country(r.BIRTH_COUNTRY_ID), country(r.NATIONALITY_COUNTRY_ID),
      str(r.CELL_PHONE), str(r.EMAIL2), JSON.stringify(address(r)), clients.get(str(r.COMPANY_ID) ?? '') ?? null, str(r.AS_FUNCTION), ref('function', r.FUNCTION_ID),
      ref('level', r.LEVEL_ID), ref('diploma', r.DIPLOMA_ID), ref('origin', r.ORIGIN_ID), pref(r.TUTOR_ID), pref(r.ACCOUNT_MANAGER_ID), pref(r.MANAGER_ID),
      !!bool(r.CANDIDATE), !!bool(r.KID), ['M', 'E'].includes(str(r.UNMESSAGABLE) ?? ''), str(r.COLOR), [str(r.NOTES), str(r.INFO)].filter(Boolean).join('\n') || null,
      JSON.stringify(customFields(r.CUSTOMIZED_ADDITION_FIELD)), JSON.stringify(leftovers(r, USED.actor)), createdAt(r)], { id: uuid, legacyId: id });
    for (const role of roles) w.add('person', 'person_roles', ['tenant_id', 'person_id', 'role'], [w.tenantId, uuid, role], { journal: false });
    w.stat('person').create -= roles.size;
    if (roles.has('trainer')) trainers.push(r);
  }
  await w.flush();
  for (const r of trainers) {
    w.add('trainer', 'trainer_profiles', ['tenant_id', 'person_id', 'status', 'active', 'hourly_rate', 'night_rate', 'holiday_rate', 'monthly_hours', 'contract_type', 'siret',
      'activity_declaration_number', 'insurance', 'urssaf', 'iban', 'bic', 'bank', 'hired_on', 'left_on', 'available_from', 'professional_card'],
    [w.tenantId, persons.get(str(r.ID)!), str(r.SIRET) || str(r.ACTIVITY_DECLARATION_NUMBER) ? 'external' : 'internal', !(bool(r.ARCHIVED) || bool(r.ACTIVATED) === false),
      num(r.HOURLY_RATE), num(r.NIGHT_RATE), num(r.BANK_HOLIDAY_RATE), num(r.MONTHLY_HOURS), str(r.CONTRACT_TYPE), str(r.SIRET), str(r.ACTIVITY_DECLARATION_NUMBER),
      str(r.INSURANCE_COMPANY), str(r.URSAAF), str(r.IBAN), str(r.BIC), str(r.BANK), date(r.HIRING_DATE) ?? date(r.ENTRY_DATE), date(r.RELEASE_DATE), date(r.AVAILIBILITY_DATE),
      str(r.PROFESSION_TITLE) ? JSON.stringify({ title: str(r.PROFESSION_TITLE), number: str(r.PROFESSION_TITLE_NUMBER), valid_until: date(r.PROFESSION_TITLE_END_VALIDITY_DATE) }) : null],
    { journal: false });
  }
  // Contacts d'entreprise (actor_company + actor.COMPANY_ID des contacts).
  const contactPairs = new Map<string, boolean>();
  for (const r of T('actor_company').filter(local)) {
    const p = pref(r.ACTOR_ID), c = clients.get(str(r.COMPANY_ID) ?? '');
    if (p && c && !existingPersons.has(str(r.ACTOR_ID)!)) contactPairs.set(`${c}|${p}`, !!bool(r.INVOICE_RECEIPT));
  }
  for (const r of actors) {
    const c = clients.get(str(r.COMPANY_ID) ?? '');
    if (c && bool(r.CONTACT) && !existingPersons.has(str(r.ID)!)) contactPairs.set(`${c}|${persons.get(str(r.ID)!)}`, contactPairs.get(`${c}|${persons.get(str(r.ID)!)}`) ?? false);
  }
  const actorById = new Map(actors.map((a) => [str(a.ID)!, a]));
  const actorByUuid = new Map(actors.map((a) => [persons.get(str(a.ID)!)!, a]));
  const actorCompany = new Map(T('actor_company').filter(local).map((r) => [str(r.ID)!, str(r.ACTOR_ID)]));
  for (const [k, inv] of contactPairs) {
    const [c, p] = k.split('|');
    const a = actorByUuid.get(p);
    w.add('contact', 'client_contacts', ['tenant_id', 'client_id', 'person_id', 'position', 'receives_invoices'], [w.tenantId, c, p, a ? str(a.AS_FUNCTION) : null, inv], { journal: false });
  }
  await w.flush();

  // Clients particuliers et liens client/financeur (customer).
  const customerClient = new Map<string, string>(); // customer.ID → client uuid
  for (const r of customers) {
    const id = str(r.ID)!;
    const company = clients.get(str(r.COMPANY_ID) ?? '');
    if (company) { customerClient.set(id, company); continue; }
    const person = pref(r.ACTOR_ID);
    if (!person) continue;
    const legacy = `customer:${id}`;
    w.read('client');
    if (clients.has(legacy)) { customerClient.set(id, clients.get(legacy)!); w.unchanged('client'); continue; }
    const a = actorById.get(str(r.ACTOR_ID)!);
    const uuid = w.newId();
    clients.set(legacy, uuid); customerClient.set(id, uuid);
    w.add('client', 'clients', ['id', 'tenant_id', 'kind', 'status', 'name', 'person_id', 'billing_email', 'billing_address', 'legacy_id', 'tariff_id', 'legacy'],
      [uuid, w.tenantId, 'person', 'customer', a ? `${str(a.LASTNAME) ?? ''} ${str(a.FIRSTNAME) ?? ''}`.trim() || `Client ${id}` : `Client ${id}`, person,
        a ? str(a.EMAIL) : null, JSON.stringify(a ? address(a) : {}), legacy, ref('tariff', r.TARIFF_ID),
        JSON.stringify({ customer_id: id, opca_id: str(r.OPCA_ID), opca_asp: str(r.OPCA_ASP) })], { id: uuid, legacyId: legacy });
  }
  await w.flush();
  /** Payeur MCDF (customer, company ou actor client) → client TMS. */
  const payer = (v: DumpValue) => {
    const s = str(v); if (!s) return null;
    return customerClient.get(s) ?? clients.get(s) ?? clients.get(`customer:${s}`) ?? null;
  };

  // Compétences et diplômes.
  const quals = await known('person_qualifications');
  const qual = (kind: string, r: Row, v: Record<string, unknown>) => {
    const legacy = `${kind}:${str(r.ID)}`;
    w.read('qualification');
    const person = pref(r.ACTOR_ID);
    if (!person) { w.exclude('qualification'); return; }
    if (quals.has(legacy)) { w.unchanged('qualification'); return; }
    const uuid = w.newId();
    w.add('qualification', 'person_qualifications', ['id', 'tenant_id', 'person_id', 'kind', 'reference_id', 'level_id', 'label', 'organisation', 'starts_on', 'ends_on',
      'delivered_on', 'valid_until', 'recycling_on', 'mark', 'validated', 'comment', 'legacy_id'],
    [uuid, w.tenantId, person, v.kind, v.reference_id ?? null, ref('level', r.LEVEL_ID), v.label ?? null, v.organisation ?? null, v.starts_on ?? null, v.ends_on ?? null,
      v.delivered_on ?? null, v.valid_until ?? null, v.recycling_on ?? null, num(r.MARK), bool(r.VALIDATED), str(r.COMMENT), legacy], { id: uuid, legacyId: legacy });
  };
  for (const r of T('actor_discipline').filter(mine)) qual('discipline', r, { kind: 'discipline', reference_id: ref('discipline', r.DISCIPLINE_ID), delivered_on: date(r.DIPLOMA_DELIVERY_DATE), valid_until: date(r.DIPLOMA_VALIDITY_END_DATE), recycling_on: date(r.RECYCLING_DATE) });
  for (const r of T('actor_diploma').filter(mine)) qual('diploma', r, { kind: 'diploma', reference_id: ref('diploma', r.DIPLOMA_ID), delivered_on: date(r.DIPLOMA_DELIVERY_DATE) });
  for (const r of T('skillful').filter(mine)) qual('skillful', r, { kind: str(r.DIPLOMA_ID) || str(r.OTHER_DIPLOMA) ? 'diploma' : 'experience', reference_id: ref('diploma', r.DIPLOMA_ID), label: str(r.NAME) ?? str(r.OTHER_DIPLOMA), organisation: str(r.COMPANY), starts_on: date(r.START_DATE), ends_on: date(r.END_DATE) });
  await w.flush();

  // ─── 4. Formations (training, training_entity) ────────────────────────────
  const programs = await known('programs');
  const sharedTrainings = new Set(T('training_entity').filter(local).map((r) => str(r.TRAINING_ID)!));
  const programVersion = new Map<string, string>(); // program uuid → version uuid
  for (const x of await many(tx, `SELECT DISTINCT ON (program_id) program_id, id FROM program_versions ORDER BY program_id, version DESC`)) programVersion.set(x.program_id, x.id);
  const addProgram = (r: Row) => {
    const id = str(r.ID)!;
    w.read('program');
    if (programs.has(id)) { w.unchanged('program'); return; }
    const uuid = w.newId(), pv = w.newId();
    programs.set(id, uuid); programVersion.set(uuid, pv);
    w.add('program', 'programs', ['id', 'tenant_id', 'code', 'title', 'archived_at', 'legacy_id', 'color', 'unit', 'days', 'cost', 'family_id', 'nature_id', 'discipline_id',
      'level_id', 'diploma_id', 'course_type_id', 'assessment_id', 'is_educational', 'is_certifying', 'in_bpf', 'by_hour', 'with_meal', 'subcontractor', 'support',
      'accounting_account', 'accounting_organisation', 'legacy', 'created_at'],
    [uuid, w.tenantId, str(r.CODE), str(r.NAME) ?? `Formation ${id}`, bool(r.ACTIVATED) === false ? new Date().toISOString() : null, id, str(r.COLOR), str(r.UNIT), num(r.DAYS),
      num(r.COST), ref('family', r.FAMILY_ID), ref('nature', r.NATURE_ID), ref('discipline', r.DISCIPLINE_ID), ref('level', r.LEVEL_ID), ref('diploma', r.DIPLOMA_ID),
      ref('course_type', r.COURSE_TYPE_ID), ref('assessment', r.ASSESSMENT_ID), bool(r.EDUCATIONAL), bool(r.CERTIFYING), bool(r.BPF), bool(r.BY_HOUR), bool(r.MEAL),
      str(r.SUBCONTRACTOR), str(r.SUPPORT), str(r.ACCOUNT_ACCOUNTING), str(r.ACCOUNT_ORGANIZATION), JSON.stringify(leftovers(r, USED.training)), createdAt(r)],
    { id: uuid, legacyId: id });
    const hours = num(r.HOURS) ?? (num(r.DAYS) != null ? num(r.DAYS)! * 7 : null);
    w.add('program', 'program_versions', ['id', 'tenant_id', 'program_id', 'version', 'duration_minutes', 'modality', 'price_ht', 'vat_rate', 'locked_at'],
      [pv, w.tenantId, uuid, 1, Math.max(1, Math.round((hours ?? 1) * 60)), 'onsite', num(r.PRICE), vatRate.get(str(r.VAT_ID) ?? '') ?? null, new Date().toISOString()], { journal: false });
    w.stat('program').create--;
    if (hours == null) w.warn('program', id, 'Durée absente : 1 h appliquée, à corriger.');
  };
  for (const r of T('training').filter((r) => local(r) || sharedTrainings.has(str(r.ID)!))) addProgram(r);
  await w.flush();
  const placeholderProgram = async () => {
    if (programs.has('__mcdf__')) return programs.get('__mcdf__')!;
    addProgram({ ID: '__mcdf__', NAME: 'Formation non renseignée (reprise MCDF)', HOURS: '1' });
    await w.flush();
    return programs.get('__mcdf__')!;
  };
  for (const r of T('tariff_training').filter(mine)) {
    const t = ref('tariff', r.TARIFF_ID), p = programs.get(str(r.TRAINING_ID) ?? ''), price = num(r.PRICE);
    w.read('tariff_price');
    if (!t || !p || price == null) { w.exclude('tariff_price'); continue; }
    w.add('tariff_price', 'tariff_prices', ['tenant_id', 'tariff_id', 'program_id', 'price_ht', 'legacy_id'], [w.tenantId, t, p, price, str(r.ID)], { journal: false });
  }
  await tx.query(`SAVEPOINT tp`);
  try { await w.flush(); await tx.query(`RELEASE SAVEPOINT tp`); }
  catch { await tx.query(`ROLLBACK TO SAVEPOINT tp`); w.warn('tariff_price', null, 'Tarifs déjà repris : ignorés.'); }

  // ─── 5. Salles (room) ─────────────────────────────────────────────────────
  const rooms = await known('resources');
  for (const r of T('room').filter(local)) {
    const id = str(r.ID)!;
    w.read('resource');
    if (rooms.has(id)) { w.unchanged('resource'); continue; }
    const uuid = w.newId();
    rooms.set(id, uuid);
    const a = address(r);
    w.add('resource', 'resources', ['id', 'tenant_id', 'kind', 'name', 'location', 'address', 'archived_at', 'legacy_id', 'code', 'color', 'hourly_cost', 'is_external',
      'uncontrolled', 'postal_address', 'contact', 'logistic_type_id', 'legacy'],
    [uuid, w.tenantId, 'room', str(r.NAME) ?? str(r.CODE) ?? `Salle ${id}`, (a as any).city ?? null, [a.line1, a.line2, a.postal_code, a.city].filter(Boolean).join(', ') || null,
      bool(r.ACTIVATED) === false ? new Date().toISOString() : null, id, str(r.CODE), str(r.COLOR), num(r.HOURLY_COST), !!bool(r.EXTERNAL), !!bool(r.UNCONTROLLED),
      JSON.stringify(a), str(r.CONTACT_NAME) || str(r.CONTACT_PHONE) || str(r.CONTACT_EMAIL) ? JSON.stringify({ name: str(r.CONTACT_NAME), phone: str(r.CONTACT_PHONE), email: str(r.CONTACT_EMAIL) }) : null,
      ref('logistic_type', r.LOGISTIC_TYPE_ID), JSON.stringify(leftovers(r, USED.room))], { id: uuid, legacyId: id });
  }
  await w.flush();

  // ─── 6. Conventions (convention + annexes) ────────────────────────────────
  const conventions = await known('conventions');
  const convRows = T('convention').filter(local);
  const newConv = new Set<string>();
  for (const r of convRows) {
    const id = str(r.ID)!;
    w.read('convention');
    if (conventions.has(id)) { w.unchanged('convention'); continue; }
    const uuid = w.newId();
    conventions.set(id, uuid); newConv.add(id);
    const dates: Record<string, string | null> = {};
    for (const k of ['LISTING', 'PROVISIONAL', 'SIGNING', 'CONVENTION', 'BILLING', 'CALLING', 'ATTESTATION', 'STATEMENT', 'TRANSFERT', 'NEXT_BILLING']) {
      const d = date(r[`${k}_DATE`]); if (d) dates[k.toLowerCase()] = d;
    }
    w.add('convention', 'conventions', ['id', 'tenant_id', 'legacy_id', 'code', 'proposal_code', 'name', 'title', 'client_id', 'contact_person_id', 'account_manager_person_id',
      'manager_person_id', 'funder_client_id', 'is_proposal', 'is_convention', 'proposal_status', 'status', 'contract_type_id', 'starts_on', 'ends_on', 'dates', 'hours',
      'invoiced_hours', 'fulfilled_hours', 'hours_to_invoice', 'estimate', 'support_number', 'reason', 'competitor', 'origin_id', 'is_template', 'invoiced',
      'attendee_support', 'invoice_unscheduled', 'active', 'archived_at', 'notes', 'custom_fields', 'legacy', 'created_at'],
    [uuid, w.tenantId, id, str(r.CODE), str(r.PROPOSAL_CODE), str(r.NAME), str(r.TITLE), payer(r.CUSTOMER_ID), pref(actorCompany.get(str(r.CONTACT_ID) ?? '') ?? r.CONTACT_ID), pref(r.ACCOUNT_MANAGER_ID),
      pref(r.MANAGER_ID), payer(r.OPCA_ID), !!bool(r.IS_PROPOSAL), !!bool(r.IS_CONVENTION), str(r.PROPOSAL_STATUS), str(r.CONVENTION_STATUS),
      ref('contract_type', r.CONTRACT_TYPE_ID), date(r.START_DATE), date(r.END_DATE), JSON.stringify(dates), num(r.HOURS), num(r.INVOICED_HOURS), num(r.FULFILLED_HOURS),
      num(r.HOURS_TO_INVOICE), num(r.ESTIMATE), str(r.SUPPORT_NUMBER), str(r.REASON), str(r.COMPETITOR), ref('origin', r.ORIGIN_ID), !!bool(r.PATTERN), !!bool(r.INVOICED),
      bool(r.ATTENDEE_SUPPORT), bool(r.INVOICE_NO_SCHEDULED_EVENT), bool(r.ACTIVATED) !== false, bool(r.ARCHIVED) ? new Date().toISOString() : null, str(r.NOTES),
      JSON.stringify(customFields(r.CUSTOMIZED_ADDITION_FIELD)), JSON.stringify(leftovers(r, USED.convention)), createdAt(r)], { id: uuid, legacyId: id });
  }
  await w.flush();
  for (const r of convRows) if (str(r.PATTERN_ID) && newConv.has(str(r.ID)!) && conventions.get(str(r.PATTERN_ID)!)) {
    await tx.query(`UPDATE conventions SET template_id=$2 WHERE id=$1`, [conventions.get(str(r.ID)!), conventions.get(str(r.PATTERN_ID)!)]);
  }
  const convOf = (v: DumpValue) => (v == null ? null : conventions.get(String(v)) ?? null);
  const isNewConv = (v: DumpValue) => v != null && newConv.has(String(v));
  // Types de contrat multiples, financeurs additionnels.
  const ctypes = new Map<string, string[]>();
  for (const r of T('convention_contract_type').filter(mine)) if (isNewConv(r.CONVENTION_ID) && ref('contract_type', r.CONTRACT_TYPE_ID)) {
    const k = str(r.CONVENTION_ID)!; ctypes.set(k, [...(ctypes.get(k) ?? []), ref('contract_type', r.CONTRACT_TYPE_ID)!]);
  }
  for (const [k, ids] of ctypes) await tx.query(`UPDATE conventions SET contract_type_ids=$2 WHERE id=$1`, [conventions.get(k), [...new Set(ids)]]);
  const payerPairs = new Set<string>();
  for (const r of T('convention_payer').filter(mine)) {
    w.read('convention_payer');
    const c = convOf(r.CONVENTION_ID), p = payer(r.OPCA_ID);
    if (!isNewConv(r.CONVENTION_ID)) { w.unchanged('convention_payer'); continue; }
    if (!c || !p || payerPairs.has(`${c}|${p}`)) { w.exclude('convention_payer'); continue; }
    payerPairs.add(`${c}|${p}`);
    w.add('convention_payer', 'convention_payers', ['tenant_id', 'convention_id', 'client_id', 'legacy_id'], [w.tenantId, c, p, str(r.ID)], { journal: false });
  }
  await w.flush();

  // ─── 7. Sessions (session) ────────────────────────────────────────────────
  const sessions = await known('training_sessions');
  const sessRows = T('session').filter(local);
  const refUsed = new Set((await many(tx, `SELECT lower(reference) r FROM training_sessions WHERE reference IS NOT NULL`)).map((x) => x.r));
  const convById = new Map(convRows.map((x) => [str(x.ID)!, x]));
  const lineSession = new Map<string, string>(); // session legacy → client (intra) quand une seule convention/un seul client
  const sessClients = new Map<string, Set<string>>();
  for (const l of T('convention_training')) {
    const s = str(l.SESSION_ID ?? l.session_id), c = convById.get(str(l.CONVENTION_ID) ?? '');
    if (s && c && payer(c.CUSTOMER_ID)) { sessClients.set(s, (sessClients.get(s) ?? new Set()).add(payer(c.CUSTOMER_ID)!)); }
  }
  for (const [s, set] of sessClients) if (set.size === 1) lineSession.set(s, [...set][0]);
  for (const r of sessRows) {
    const id = str(r.ID)!;
    w.read('session');
    if (sessions.has(id)) { w.unchanged('session'); continue; }
    const uuid = w.newId();
    sessions.set(id, uuid);
    let program = programs.get(str(r.TRAINING_ID) ?? '');
    if (!program) { program = await placeholderProgram(); w.warn('session', id, 'Formation absente : rattachée à « Formation non renseignée ».'); }
    const start = date(r.START_DATE), end = date(r.END_DATE) ?? start;
    const historical = !!end && end < o.today;
    const status = bool(r.ARCHIVED) ? 'archived' : bool(r.ACTIVATED) === false ? 'cancelled' : historical ? 'completed' : start ? 'planned' : 'draft';
    let reference = str(r.CODE);
    if (reference && refUsed.has(reference.toLowerCase())) { w.warn('session', id, `Code session « ${reference} » en double : suffixé.`); reference = `${reference}-${id}`; }
    if (reference) refUsed.add(reference.toLowerCase());
    const cap = int(r.NUMBER_MAXI), min = int(r.NUMBER_MINI);
    const hours = num(r.HOURS);
    w.add('session', 'training_sessions', ['id', 'tenant_id', 'program_version_id', 'kind', 'client_id', 'title', 'status', 'capacity', 'timezone', 'starts_on', 'ends_on',
      'location', 'is_historical', 'reference', 'min_participants', 'target_minutes', 'legacy_id', 'hourly_rate', 'daily_rate', 'planned_days', 'default_trainer_id',
      'default_room_id', 'manager_person_id', 'discipline_id', 'default_times', 'registrations_open', 'overbooking', 'motive', 'outfit', 'features', 'custom_fields', 'legacy', 'created_at'],
    [uuid, w.tenantId, programVersion.get(program), lineSession.has(id) ? 'intra' : 'inter', lineSession.get(id) ?? null, str(r.NAME) ?? `Session ${id}`, status,
      cap && cap > 0 ? cap : null, o.timezone, start, end && start && end < start ? start : end, null, historical, reference, min && min >= 0 ? min : null,
      hours && hours > 0 ? Math.round(hours * 60) : null, id, num(r.HOURLY_RATE), num(r.DAILY_RATE), num(r.DAYS), pref(r.TRAINER_ID), rooms.get(str(r.ROOM_ID) ?? '') ?? null,
      pref(r.MANAGER_ID), ref('discipline', r.DISCIPLINE_ID),
      JSON.stringify({ start: time(r.START_TIME), end: time(r.END_TIME), week_days: str(r.WEEK_DAY) }), bool(r.OPENED), bool(r.SURBOOKING), str(r.MOTIF), str(r.OUTFIT),
      str(r.FEATURE), JSON.stringify(customFields(r.CUSTOMIZED_ADDITION_FIELD)), JSON.stringify(leftovers(r, USED.session)), createdAt(r)], { id: uuid, legacyId: id });
  }
  await w.flush();

  // Lignes de convention (convention_training) et échéancier (timetable).
  const lines = await known('convention_lines');
  for (const r of T('convention_training').filter((r) => convOf(r.CONVENTION_ID))) {
    const id = str(r.ID)!;
    w.read('convention_line');
    if (lines.has(id)) { w.unchanged('convention_line'); continue; }
    const conv = convOf(r.CONVENTION_ID);
    if (!conv) { w.exclude('convention_line'); continue; }
    const uuid = w.newId();
    lines.set(id, uuid);
    w.add('convention_line', 'convention_lines', ['id', 'tenant_id', 'convention_id', 'program_id', 'session_id', 'payer_client_id', 'position', 'unit_price_ht', 'quantity',
      'amount_ht', 'discount', 'vat_rate', 'installments', 'status', 'invoiced', 'is_certifying', 'subcontracted', 'comment', 'proposal_comment', 'legacy_id', 'legacy'],
    [uuid, w.tenantId, conv, programs.get(str(r.TRAINING_ID) ?? '') ?? null, sessions.get(str(r.SESSION_ID ?? r.session_id) ?? '') ?? null, payer(r.PAYER_ID), int(r.SEQUENCE),
      num(r.PRICE), num(r.QUANTITY), num(r.AMOUNT), num(r.DISCOUNT), num(r.VAT_RATE) ?? vatRate.get(str(r.VAT_ID) ?? '') ?? null, int(r.TIMETABLE_COUNT), str(r.STATUS),
      !!bool(r.INVOICED), bool(r.CERTIFYING), str(r.SUBCONTRACTED), str(r.COMMENT), str(r.PROPOSAL_COMMENT), id, JSON.stringify({ vat_id: str(r.VAT_ID) })], { id: uuid, legacyId: id });
  }
  await w.flush();
  const installments = await known('convention_installments');
  const installmentByLine = new Map<string, string>(); // invoice_line legacy → installment uuid
  for (const r of T('timetable').filter((r) => lines.has(str(r.CONVENTION_TRAINING_ID) ?? ''))) {
    const id = str(r.ID)!;
    w.read('installment');
    if (installments.has(id)) { w.unchanged('installment'); continue; }
    const line = lines.get(str(r.CONVENTION_TRAINING_ID) ?? '');
    if (!line) { w.exclude('installment'); continue; }
    const uuid = w.newId();
    if (str(r.INVOICE_LINE_ID)) installmentByLine.set(str(r.INVOICE_LINE_ID)!, uuid);
    w.add('installment', 'convention_installments', ['id', 'tenant_id', 'convention_line_id', 'payer_client_id', 'payment_method', 'billing_on', 'quantity', 'unit_price_ht',
      'amount_ht', 'subcontracted', 'legacy_id'],
    [uuid, w.tenantId, line, payer(r.PAYER_ID), paymentType.get(str(r.PAYMENT_TYPE_ID) ?? '') ?? null, date(r.BILLING_DATE), num(r.QUANTITY), num(r.PRICE),
      num(r.DISCOUNTED_AMOUNT), str(r.SUBCONTRACTED), id], { id: uuid, legacyId: id });
  }
  await w.flush();
  // Commerciaux / rémunérations rattachés à la convention.
  const staffPairs = new Map<string, { rate: number | null; pct: number | null; legacy: string }>();
  for (const r of T('actor_convention').filter(mine)) if (isNewConv(r.CONVENTION_ID) && pref(r.ACTOR_ID)) {
    staffPairs.set(`${convOf(r.CONVENTION_ID)}|${pref(r.ACTOR_ID)}`, { rate: num(r.HOURLY_RATE), pct: null, legacy: str(r.ID)! });
  }
  for (const r of T('commission').filter(mine)) if (isNewConv(r.CONVENTION_ID) && pref(r.ACTOR_ID)) {
    const k = `${convOf(r.CONVENTION_ID)}|${pref(r.ACTOR_ID)}`;
    staffPairs.set(k, { rate: staffPairs.get(k)?.rate ?? null, pct: num(r.COMMISSION), legacy: str(r.ID)! });
  }
  for (const [k, v] of staffPairs) {
    const [c, p] = k.split('|');
    w.add('convention_staff', 'convention_staff', ['tenant_id', 'convention_id', 'person_id', 'hourly_rate', 'commission_pct', 'legacy_id'], [w.tenantId, c, p, v.rate, v.pct, v.legacy], { journal: false });
  }
  await w.flush();

  // ─── 8. Stagiaires et inscriptions ────────────────────────────────────────
  const convAttendees = new Map<string, { conv: string; person: string; objective: string | null }>(); // convention_attendee.ID →
  const caKnown = await known('convention_attendees');
  const caPairs = new Set<string>();
  for (const r of T('convention_attendee').filter(mine)) {
    const id = str(r.ID)!;
    const conv = convOf(r.CONVENTION_ID), person = pref(r.ATTENDEE_ID) ?? pref(r.USER_ATTENDEE_ID);
    w.read('convention_attendee');
    if (!conv || !person) { w.exclude('convention_attendee'); if (conv && !person) w.warn('convention_attendee', id, 'Stagiaire introuvable.'); continue; }
    convAttendees.set(id, { conv, person, objective: str(r.OBJECTIF) });
    if (caKnown.has(id)) { w.unchanged('convention_attendee'); continue; }
    if (caPairs.has(`${conv}|${person}`)) { w.exclude('convention_attendee'); continue; }
    caPairs.add(`${conv}|${person}`);
    const uuid = w.newId();
    w.add('convention_attendee', 'convention_attendees', ['id', 'tenant_id', 'convention_id', 'person_id', 'objective', 'active', 'legacy_id'],
      [uuid, w.tenantId, conv, person, str(r.OBJECTIF), bool(r.ACTIVATED) !== false, id], { id: uuid, legacyId: id });
  }
  await w.flush();

  const convClient = new Map<string, string | null>();
  for (const r of convRows) convClient.set(conventions.get(str(r.ID)!)!, payer(r.CUSTOMER_ID));
  const enrollments = new Map<string, string>(); // session uuid|person uuid → enrollment uuid
  for (const x of await many(tx, `SELECT id, session_id, person_id FROM enrollments`)) enrollments.set(`${x.session_id}|${x.person_id}`, x.id);
  const enrollmentKnown = new Set(enrollments.values());
  const sessionById = new Map(sessRows.map((s) => [str(s.ID)!, s]));
  const enroll = (session: string, person: string, legacyId: string, conv: string | null, objective: string | null) => {
    const key = `${session}|${person}`;
    w.read('enrollment');
    if (enrollments.has(key)) { w.unchanged('enrollment'); return; }
    const uuid = w.newId();
    enrollments.set(key, uuid);
    const personRow = actorByUuid.get(person);
    const client = (conv ? convClient.get(conv) : null) ?? (personRow ? clients.get(str(personRow.COMPANY_ID) ?? '') : null) ?? null;
    w.add('enrollment', 'enrollments', ['id', 'tenant_id', 'session_id', 'person_id', 'client_id', 'status', 'legacy_id', 'convention_id', 'objective'],
      [uuid, w.tenantId, session, person, client, 'confirmed', legacyId, conv, objective], { id: uuid, legacyId });
  };
  // Stagiaires d'une session = stagiaires des conventions ayant une ligne sur cette session ;
  // convention_attendee_session, s'il existe pour un stagiaire, restreint ses sessions.
  const restricted = new Set<string>();
  for (const r of T('convention_attendee_session').filter(mine)) {
    const ca = convAttendees.get(str(r.CONVENTION_ATTENDEE_ID) ?? '');
    const s = sessions.get(str(r.SESSION_ID) ?? '');
    if (!ca || !s) { w.read('enrollment'); w.exclude('enrollment'); continue; }
    restricted.add(str(r.CONVENTION_ATTENDEE_ID)!);
    enroll(s, ca.person, str(r.ID)!, ca.conv, ca.objective);
  }
  const convSessions = new Map<string, Set<string>>();
  for (const l of T('convention_training')) {
    const c = convOf(l.CONVENTION_ID), s = sessions.get(str(l.SESSION_ID ?? l.session_id) ?? '');
    if (c && s) convSessions.set(c, (convSessions.get(c) ?? new Set()).add(s));
  }
  for (const [id, ca] of convAttendees) if (!restricted.has(id)) for (const s of convSessions.get(ca.conv) ?? []) enroll(s, ca.person, `ca:${id}:${s}`, ca.conv, ca.objective);
  await w.flush();

  // ─── 9. Créneaux (schedule : CONF = séance, CSTR = contrainte, CLOS = fermeture) ─
  const slots = await known('slots');
  const scheduleRows = T('schedule').filter(local);
  const slotOf = new Map<string, { id: string; minutes: number; session: string }>();
  for (const x of await many(tx, `SELECT legacy_id, id, session_id, extract(epoch FROM ends_at - starts_at)::int / 60 AS m FROM slots WHERE legacy_id IS NOT NULL`)) slotOf.set(x.legacy_id, { id: x.id, minutes: x.m, session: x.session_id });
  const extraRooms = new Map<string, string[]>();
  for (const r of T('schedule_room').filter(mine)) if (bool(r.ACTIVATED) !== false) {
    const k = str(r.SCHEDULE_ID)!; extraRooms.set(k, [...(extraRooms.get(k) ?? []), str(r.ROOM_ID)!]);
  }
  // Formateurs : actor_schedule ACTOR='TRAINER' (le principal est schedule.TRAINER_ID).
  const actorSchedule = T('actor_schedule').filter(mine);
  const slotTrainers = new Map<string, string[]>();
  for (const r of actorSchedule) if (str(r.ACTOR) === 'TRAINER') {
    const k = str(r.SCHEDULE_ID)!; slotTrainers.set(k, [...(slotTrainers.get(k) ?? []), str(r.ACTOR_ID)!]);
  }
  const constraints: Row[] = [], closed: Row[] = [];
  const DONE = new Set(['FULFILLED', 'TIMESHEET', 'VALIDATED', 'INVOICED', 'PAST']);
  for (const r of scheduleRows) {
    const id = str(r.ID)!;
    const type = (str(r.TYPE) ?? 'CONF').toUpperCase();
    const st = (str(r.STATUS) ?? 'CURRENT').toUpperCase();
    w.read('slot');
    if (slots.has(id)) { w.unchanged('slot'); continue; }
    if (type === 'CLOS') { closed.push(r); w.exclude('slot'); continue; }
    if (type === 'CSTR' || str(r.SCHEDULE_ID)) { constraints.push(r); w.exclude('slot'); continue; }
    if (st === 'PATTERN') { w.exclude('slot'); continue; } // créneau modèle de parcours
    const session = sessions.get(str(r.SESSION_ID) ?? '');
    if (!session) { w.exclude('slot'); if (str(r.SESSION_ID)) w.warn('slot', id, 'Séance d’une session non reprise : ignorée.'); continue; }
    const span = slotSpan(r);
    if (!span) { w.reject('slot', id, 'Créneau sans date/heure exploitable.'); continue; }
    const uuid = w.newId();
    const minutes = Math.round((Date.parse(span.end + 'Z') - Date.parse(span.start + 'Z')) / 60000);
    slotOf.set(id, { id: uuid, minutes, session });
    const s = sessionById.get(str(r.SESSION_ID)!);
    const cancelled = st === 'CANCELED' || bool(r.ACTIVATED) === false;
    const past = span.end.slice(0, 10) < o.today;
    const status = cancelled ? 'cancelled' : DONE.has(st) || past ? 'done' : st === 'DRAFT' ? 'draft' : st === 'REQUEST' ? 'pending' : 'published';
    w.add('slot', 'slots', ['id', 'tenant_id', 'session_id', ts, te, 'status', 'notes', 'published_at', 'cancel_reason', 'cancelled_at', 'legacy_id', 'color', 'discipline_id', 'kind', 'legacy'],
      [uuid, w.tenantId, session, span.start, span.end, status, str(r.COMMENT), ['cancelled', 'draft', 'pending'].includes(status) ? null : new Date().toISOString(),
        cancelled ? (bool(r.ASP) ? 'Annulé sans préavis (MCDF)' : 'Annulé dans MCDF') : null, cancelled ? new Date().toISOString() : null, id, str(r.COLOR),
        ref('discipline', r.DISCIPLINE_ID) ?? (s ? ref('discipline', s.DISCIPLINE_ID) : null), type, JSON.stringify(leftovers(r, USED.schedule))], { id: uuid, legacyId: id });
    const lead = pref(r.TRAINER_ID) ?? pref(r.USER_TRAINER_ID);
    const all = new Set([lead, ...(slotTrainers.get(id) ?? []).map((x) => pref(x))].filter(Boolean) as string[]);
    for (const t of all) w.add('slot', 'slot_trainers', ['tenant_id', 'slot_id', 'person_id', 'role'], [w.tenantId, uuid, t, t === lead ? 'lead' : 'co'], { journal: false });
    const roomIds = new Set([str(r.ROOM_ID), ...(extraRooms.get(id) ?? [])].filter(Boolean).map((x) => rooms.get(x!)).filter(Boolean) as string[]);
    for (const room of roomIds) w.add('slot', 'slot_resources', ['tenant_id', 'slot_id', 'resource_id'], [w.tenantId, uuid, room], { journal: false });
    w.stat('slot').create -= all.size + roomIds.size;
  }
  await w.flush();
  // Contraintes (indisponibilités formateur ou salle) et jours fermés.
  const availKnown = new Set((await many(tx, `SELECT x.external_id FROM external_identities x WHERE x.entity_type='mcdf.availability'`)).map((x) => x.external_id));
  for (const r of constraints) {
    const span = slotSpan(r), id = str(r.ID)!;
    w.read('availability');
    if (availKnown.has(id)) { w.unchanged('availability'); continue; }
    const owner = pref(r.TRAINER_ID) ?? pref(r.USER_TRAINER_ID);
    const room = rooms.get(str(r.ROOM_ID) ?? '');
    if (!span || span.end <= span.start || (!owner && !room) || (str(r.STATUS) ?? '').toUpperCase() === 'CANCELED') { w.exclude('availability'); continue; }
    const uuid = w.newId();
    w.add('availability', 'availabilities', ['id', 'tenant_id', 'owner_type', 'owner_id', 'kind', ts, te, 'reason', 'status'],
      [uuid, w.tenantId, owner ? 'person' : 'resource', owner ?? room, 'unavailable', span.start, span.end, str(r.COMMENT) ?? (str(r.SCHEDULE_ID) ? 'Temps de trajet (MCDF)' : 'Contrainte MCDF'),
        (str(r.STATUS) ?? '').toUpperCase() === 'REQUEST' ? 'pending' : 'approved'], { id: uuid, legacyId: id });
  }
  const closedDays = new Set((await many(tx, `SELECT starts_on::text d FROM closures WHERE site_id IS NULL`)).map((x) => x.d));
  for (const r of closed) {
    const span = slotSpan(r) ?? (date(r.START_DATE) ? { start: `${date(r.START_DATE)}T00:00:00`, end: `${date(r.END_DATE) ?? date(r.START_DATE)}T00:00:00` } : null);
    w.read('closure');
    if (!span || closedDays.has(span.start.slice(0, 10))) { w.exclude('closure'); continue; }
    closedDays.add(span.start.slice(0, 10));
    const uuid = w.newId();
    w.add('closure', 'closures', ['id', 'tenant_id', 'starts_on', 'ends_on', 'label'], [uuid, w.tenantId, span.start.slice(0, 10), span.end.slice(0, 10) < span.start.slice(0, 10) ? span.start.slice(0, 10) : span.end.slice(0, 10), str(r.COMMENT) ?? 'Fermeture'], { id: uuid, legacyId: str(r.ID) });
  }
  await w.flush();

  // ─── 10. Émargement (actor_schedule ; attendee_schedule = ancienne table) ──
  const attKnown = await known('attendance');
  const attPairs = new Set<string>();
  const attendanceRows = [
    ...actorSchedule.filter((r) => (str(r.ACTOR) ?? 'ATTENDEE') === 'ATTENDEE').map((r) => ({ r, table: 'actor_schedule', person: r.ACTOR_ID })),
    ...T('attendee_schedule').filter(mine).map((r) => ({ r, table: 'attendee_schedule', person: r.ATTENDEE_ID ?? r.USER_ATTENDEE_ID })),
  ];
  for (const { r, table, person: pid } of attendanceRows) {
    const id = table === 'actor_schedule' ? str(r.ID)! : `as:${str(r.ID)}`;
    w.read('attendance');
    if (attKnown.has(id)) { w.unchanged('attendance'); continue; }
    const slot = slotOf.get(str(r.SCHEDULE_ID) ?? '');
    const person = pref(pid);
    if (!slot || !person) { w.exclude('attendance'); continue; }
    let enr = enrollments.get(`${slot.session}|${person}`);
    if (!enr) {
      enroll(slot.session, person, `att:${id}`, null, null);
      enr = enrollments.get(`${slot.session}|${person}`)!;
      await w.flush();
    }
    if (attPairs.has(`${enr}|${slot.id}`)) { w.exclude('attendance'); continue; }
    attPairs.add(`${enr}|${slot.id}`);
    const missing = !!bool(r.MISSING);
    const uuid = w.newId();
    w.add('attendance', 'attendance', ['id', 'tenant_id', 'enrollment_id', 'slot_id', 'status', 'minutes', 'method', 'proof', 'legacy_id', 'absence_reason_id', 'billable', 'comment'],
      [uuid, w.tenantId, enr, slot.id, missing ? 'absent' : 'present', missing ? 0 : Math.max(0, slot.minutes), 'import',
        JSON.stringify({ source: 'mcdf', table, id: str(r.ID), signature: str(r.SIGNATURE_ID) }), id, ref('absence', r.ABSENCE_ID), bool(r.BILLABLE), str(r.COMMENT)], { id: uuid, legacyId: id });
  }
  await w.flush();
  const taPairs = new Set((await many(tx, `SELECT slot_id || '|' || person_id k FROM trainer_attendance`)).map((x) => x.k));
  for (const r of actorSchedule.filter((r) => str(r.ACTOR) === 'TRAINER')) {
    const slot = slotOf.get(str(r.SCHEDULE_ID) ?? ''), person = pref(r.ACTOR_ID);
    w.read('trainer_attendance');
    if (!slot || !person) { w.exclude('trainer_attendance'); continue; }
    if (taPairs.has(`${slot.id}|${person}`)) { w.unchanged('trainer_attendance'); continue; }
    taPairs.add(`${slot.id}|${person}`);
    w.add('trainer_attendance', 'trainer_attendance', ['tenant_id', 'slot_id', 'person_id', 'present', 'billable', 'absence_reason_id', 'comment', 'signature_ref', 'legacy_id'],
      [w.tenantId, slot.id, person, !bool(r.MISSING), bool(r.BILLABLE), ref('absence', r.ABSENCE_ID), str(r.COMMENT), str(r.SIGNATURE_ID), str(r.ID)], { journal: false });
  }
  await w.flush();

  // Frais (costs).
  const costsKnown = await known('session_costs');
  for (const r of T('costs').filter(mine)) {
    const id = str(r.ID)!;
    w.read('cost');
    if (costsKnown.has(id)) { w.unchanged('cost'); continue; }
    const amount = num(r.AMOUNT);
    const s = sessions.get(str(r.SESSION_ID ?? r.session_id) ?? ''), c = convOf(r.CONVENTION_ID);
    if (amount == null || (!s && !c)) { w.exclude('cost'); continue; }
    const uuid = w.newId();
    w.add('cost', 'session_costs', ['id', 'tenant_id', 'session_id', 'convention_id', 'trainer_person_id', 'cost_type_id', 'spent_on', 'amount', 'legacy_id'],
      [uuid, w.tenantId, s ?? null, c, pref(r.USER_TRAINER_ID), ref('cost', r.COST_ID), date(r.DATE_COSTS), amount, id], { id: uuid, legacyId: id });
  }
  await w.flush();

  // ─── 11. Factures, lignes, stagiaires facturés ────────────────────────────
  const invoices = await known('invoices');
  await tx.query(`INSERT INTO invoice_series(tenant_id, code, prefix, is_historical) VALUES ($1,'HIST-MCDF','',true) ON CONFLICT DO NOTHING`, [w.tenantId]);
  const invRows = T('invoice').filter(local);
  const newInv: { uuid: string; r: Row; issued: boolean }[] = [];
  const invNumbers = new Set((await many(tx, `SELECT number FROM invoices WHERE series_code='HIST-MCDF'`)).map((x) => x.number));
  const sessionOfInvoice = new Map<string, string>();
  for (const l of T('invoice_line').filter(mine)) {
    const s = sessions.get(str(l.SESSION_ID) ?? '');
    if (s && !sessionOfInvoice.has(str(l.INVOICE_ID)!)) sessionOfInvoice.set(str(l.INVOICE_ID)!, s);
  }
  for (const r of invRows) {
    const id = str(r.ID)!;
    w.read('invoice');
    if (invoices.has(id)) { w.unchanged('invoice'); continue; }
    let client = payer(r.PAYER_ID) ?? payer(r.ACCOUNT_ID);
    if (!client) { w.reject('invoice', id, `Payeur introuvable (${str(r.PAYER_NAME) ?? str(r.PAYER_ID) ?? '?'}) : facture non reprise.`); continue; }
    const ht = num(r.AMOUNT) ?? 0, vat = num(r.VAT_AMOUNT) ?? 0, ttc = num(r.TTC_AMOUNT) ?? ht + vat;
    const number = str(r.CODE);
    const issue = date(r.BILLING_DATE) ?? date(r.CREATED);
    const proforma = (str(r.STATUS) ?? 'I').toUpperCase() === 'P';
    const issued = !!number && !!issue && !proforma;
    if (issued && invNumbers.has(number!)) { w.reject('invoice', id, `Numéro de facture ${number} en double.`); continue; }
    if (issued) invNumbers.add(number!);
    const credit = (!!str(r.INVOICE_ID) && str(r.INVOICE_ID) !== id) || ttc < 0;
    const uuid = w.newId();
    invoices.set(id, uuid);
    newInv.push({ uuid, r, issued });
    if (Math.abs(Math.round(ht * 100) + Math.round(vat * 100) - Math.round(ttc * 100)) > 1) w.warn('invoice', id, `HT + TVA ≠ TTC (${ht} + ${vat} ≠ ${ttc}) : facture marquée incomplète.`);
    const snap = (p: string) => JSON.stringify({ id: str(r[`${p}_ID`]), code: str(r[`${p}_CODE`]), civility: str(r[`${p}_CIVILITY`]), name: str(r[`${p}_NAME`] ?? r[`${p}_LASTNAME`]),
      firstname: str(r[`${p}_FIRSTNAME`]), siret: str(r[`${p}_SIRET`]), vat_number: str(r[`${p}_INTRA_COMMUNITY_VAT`]), accounting_account: str(r[`${p}_ACCOUNT_ACCOUNTING`]),
      country: str(r[`${p}_COUNTRY_NAME`]), address: address(r, `${p}_`) });
    w.add('invoice', 'invoices', ['id', 'tenant_id', 'kind', 'client_id', 'session_id', 'status', 'currency', 'total_ht', 'total_vat', 'total_ttc', 'is_historical', 'is_incomplete',
      'external_ref', 'legacy_id', 'convention_id', 'payer_snapshot', 'account_snapshot', 'contact_snapshot', 'convention_snapshot', 'hours', 'days', 'deposit',
      'discounted_amount', 'payment_method', 'payment_terms', 'legacy_status', 'suspicious', 'legacy', 'created_at'],
    [uuid, w.tenantId, credit ? 'credit_note' : 'invoice', client, sessionOfInvoice.get(id) ?? null, 'draft', 'EUR', Math.abs(ht).toFixed(2), Math.abs(vat).toFixed(2), Math.abs(ttc).toFixed(2), true,
      Math.abs(Math.round(ht * 100) + Math.round(vat * 100) - Math.round(ttc * 100)) > 1, number, id, convOf(r.CONVENTION_ID), snap('PAYER'), snap('ACCOUNT'), snap('CONTACT'),
      JSON.stringify({ code: str(r.CONVENTION_CODE), proposal_code: str(r.CONVENTION_PROPOSAL_CODE), name: str(r.CONVENTION_NAME), title: str(r.CONVENTION_TITLE),
        start: date(r.CONVENTION_START_DATE), end: date(r.CONVENTION_END_DATE), support_number: str(r.CONVENTION_SUPPORT_NUMBER) }),
      num(r.HOURS), num(r.DAYS), num(r.DEPOSIT), num(r.DISCOUNTED_AMOUNT), paymentType.get(str(r.PAYMENT_TYPE_ID) ?? '') ?? null,
      JSON.stringify({ period: int(r.PAYMENT_PERIOD), day: int(r.PAYMENT_DAY), label: str(r.PAYMENT_LABEL) }), str(r.STATUS), !!bool(r.SUSPICIOUS),
      JSON.stringify({ ...leftovers(r, USED.invoice), entity_name: str(r.ENTITY_NAME), balance: str(r.BALANCE), payment_date: str(r.PAYMENT_DATE) }), createdAt(r)],
    { id: uuid, legacyId: id });
  }
  await w.flush();
  const newInvIds = new Set(newInv.map((x) => str(x.r.ID)!));
  const pos = new Map<string, number>();
  const instLinks: [string, string][] = [];
  for (const r of T('invoice_line').filter(mine)) {
    w.read('invoice_line');
    const invLegacy = str(r.INVOICE_ID) ?? '';
    if (!newInvIds.has(invLegacy)) { w[invoices.has(invLegacy) ? 'unchanged' : 'exclude']('invoice_line'); continue; }
    const inv = invoices.get(invLegacy)!;
    const n = (pos.get(inv) ?? 0) + 1; pos.set(inv, n);
    const qty = num(r.QUANTITY) ?? num(r.QTY) ?? num(r.HOURS) ?? 1, price = num(r.PRICE) ?? 0;
    const ht = num(r.DISCOUNTED_AMOUNT) ?? num(r.AMOUNT) ?? qty * price, rate = num(r.VAT_RATE) ?? 0;
    const ttc = num(r.TTC_AMOUNT) ?? ht * (1 + rate / 100);
    const uuid = w.newId();
    w.add('invoice_line', 'invoice_lines', ['id', 'tenant_id', 'invoice_id', 'position', 'label', 'quantity', 'unit_price_ht', 'vat_rate', 'total_ht', 'total_vat', 'legacy_id',
      'program_id', 'session_id', 'convention_line_id', 'hours', 'discount_amount', 'snapshot'],
    [uuid, w.tenantId, inv, int(r.CONVENTION_TRAINING_SEQUENCE) ?? n, str(r.TRAINING_NAME) ?? str(r.SESSION_NAME) ?? 'Prestation', Math.abs(qty), price, rate, Math.abs(ht).toFixed(2),
      Math.abs(ttc - ht).toFixed(2), str(r.ID), programs.get(str(r.TRAINING_ID) ?? '') ?? null, sessions.get(str(r.SESSION_ID) ?? '') ?? null,
      lines.get(str(r.CONVENTION_TRAINING_ID) ?? '') ?? null, num(r.HOURS), num(r.AMOUNT_DISCOUNT),
      JSON.stringify({ training_code: str(r.TRAINING_CODE), session_code: str(r.SESSION_CODE), session_name: str(r.SESSION_NAME), trainer: str(r.TRAINER_NAME),
        convention_code: str(r.CONVENTION_CODE), convention_name: str(r.CONVENTION_NAME), support_number: str(r.CONVENTION_SUPPORT_NUMBER) })], { id: uuid, legacyId: str(r.ID) });
    const inst = installmentByLine.get(str(r.ID)!);
    if (inst) instLinks.push([inst, uuid]);
  }
  await w.flush();
  for (let i = 0; i < instLinks.length; i += 5000) {
    const c = instLinks.slice(i, i + 5000);
    await tx.query(`UPDATE convention_installments ci SET invoice_line_id=t.l FROM unnest($1::uuid[], $2::uuid[]) t(i, l) WHERE ci.id=t.i`, [c.map((x) => x[0]), c.map((x) => x[1])]);
  }
  for (const r of T('invoice_attendee').filter(mine)) {
    w.read('invoice_attendee');
    const invLegacy = str(r.INVOICE_ID) ?? '';
    if (!newInvIds.has(invLegacy)) { w[invoices.has(invLegacy) ? 'unchanged' : 'exclude']('invoice_attendee'); continue; }
    const uuid = w.newId();
    w.add('invoice_attendee', 'invoice_attendees', ['id', 'tenant_id', 'invoice_id', 'person_id', 'snapshot', 'legacy_id'],
      [uuid, w.tenantId, invoices.get(invLegacy), pref(r.ATTENDEE_ID) ?? pref(r.USER_ATTENDEE_ID), JSON.stringify({
        name: str(r.ATTENDEE_NAME), lastname: str(r.ATTENDEE_LASTNAME), firstname: str(r.ATTENDEE_FIRSTNAME), function: str(r.FUNCTION_NAME), company: str(r.COMPANY_NAME),
        convention_code: str(r.CONVENTION_CODE), convention_name: str(r.CONVENTION_NAME), address: address(r, 'ATTENDEE_') }), str(r.ID)], { id: uuid, legacyId: str(r.ID) });
  }
  await w.flush();
  // Émission historique : numéro, date et échéance d'origine ; avoirs liés à leur facture.
  for (const { uuid, r, issued } of newInv) {
    const credited = str(r.INVOICE_ID) && str(r.INVOICE_ID) !== str(r.ID) ? invoices.get(str(r.INVOICE_ID)!) : null;
    if (credited) await tx.query(`UPDATE invoices SET credited_invoice_id=$2 WHERE id=$1 AND kind='credit_note'`, [uuid, credited]);
    if (!issued) { w.warn('invoice', str(r.ID), (str(r.STATUS) ?? '').toUpperCase() === 'P' ? `Proforma ${str(r.CODE) ?? ''} : reprise en brouillon (non émise).` : 'Facture sans numéro ou sans date : reprise en brouillon.'); continue; }
    const issue = date(r.BILLING_DATE) ?? date(r.CREATED)!;
    const due = dueDate(issue, int(r.PAYMENT_PERIOD), int(r.PAYMENT_DAY));
    await tx.query(`UPDATE invoices SET status='issued', series_code='HIST-MCDF', number=$2, issue_date=$3, due_date=$4 WHERE id=$1`, [uuid, str(r.CODE), issue, due]);
  }

  // ─── 12. Règlements et lettrage (payment, payment_invoice) ────────────────
  const payments = await known('payments');
  const allocs = T('payment_invoice').filter(mine);
  const payClient = new Map<string, string>();
  for (const a of allocs) { const inv = invoices.get(str(a.INVOICE_ID) ?? ''); if (inv && !payClient.has(str(a.PAYMENT_ID)!)) payClient.set(str(a.PAYMENT_ID)!, inv); }
  const invClient = new Map((await many(tx, `SELECT id, client_id FROM invoices`)).map((x) => [x.id, x.client_id]));
  const newPay = new Set<string>();
  for (const r of T('payment').filter(local)) {
    const id = str(r.ID)!;
    w.read('payment');
    if (payments.has(id)) { w.unchanged('payment'); continue; }
    const client = payer(r.PAYER_ID) ?? invClient.get(payClient.get(id) ?? '') ?? null;
    const amount = num(r.AMOUNT), on = date(r.PAYMENT_DATE) ?? date(r.CREATED);
    if (!client || amount == null || !on) { w.reject('payment', id, !client ? 'Payeur introuvable : règlement non repris.' : 'Montant ou date absent.'); continue; }
    const uuid = w.newId();
    payments.set(id, uuid); newPay.add(id);
    w.add('payment', 'payments', ['id', 'tenant_id', 'client_id', 'amount', 'currency', 'received_on', 'method', 'reference', 'source', 'legacy_id', 'deposit_slip_ref', 'deposit_slip_on'],
      [uuid, w.tenantId, client, amount.toFixed(2), 'EUR', on, paymentType.get(str(r.PAYMENT_TYPE_ID) ?? '') ?? 'transfer', str(r.PAYMENT_CODE), 'import', id,
        str(r.PRESENTATION_CODE), date(r.PRESENTATION_DATE)], { id: uuid, legacyId: id });
  }
  await w.flush();
  for (const a of allocs) {
    w.read('allocation');
    const p = str(a.PAYMENT_ID) ?? '', inv = invoices.get(str(a.INVOICE_ID) ?? ''), amount = num(a.AMOUNT);
    if (!newPay.has(p)) { w[payments.has(p) ? 'unchanged' : 'exclude']('allocation'); continue; }
    if (!inv || !amount || amount <= 0) { w.exclude('allocation'); continue; }
    w.add('allocation', 'payment_allocations', ['tenant_id', 'payment_id', 'invoice_id', 'amount', 'legacy_id'], [w.tenantId, payments.get(p), inv, amount.toFixed(2), str(a.ID)], { journal: false });
  }
  await w.flush();

  // ─── 13. Pièces (documents stockés dans la base MCDF) ─────────────────────
  const docOwners: [string, string, string, (r: Row) => string | null][] = [
    ['actor_document', 'person', 'ACTOR_ID', (r) => pref(r.ACTOR_ID)],
    ['company_document', 'client', 'COMPANY_ID', (r) => clients.get(str(r.COMPANY_ID) ?? '') ?? null],
    ['convention_document', 'convention', 'CONVENTION_ID', (r) => convOf(r.CONVENTION_ID)],
    ['session_document', 'session', 'SESSION_ID', (r) => sessions.get(str(r.SESSION_ID) ?? '') ?? null],
    ['training_document', 'program', 'TRAINING_ID', (r) => programs.get(str(r.TRAINING_ID) ?? '') ?? null],
  ];
  const docKnown = new Set((await many(tx, `SELECT provenance->>'table' t, legacy_id FROM documents WHERE legacy_id IS NOT NULL`)).map((x) => `${x.t}:${x.legacy_id}`));
  for (const [table, ownerType, , owner] of docOwners) {
    for (const r of T(table).filter(mine)) {
      w.read('document');
      const id = str(r.ID)!;
      if (docKnown.has(`${table}:${id}`)) { w.unchanged('document'); continue; }
      const ownerId = owner(r);
      const data = docBytes(r);
      if (!ownerId || !data) { w.exclude('document'); continue; }
      const ext = (str(r.SUFFIX) ?? '').replace(/^\./, '').toLowerCase();
      const name = str(r.NAME) ?? `document-${id}`;
      docs.push({ table, legacyId: id, ownerType, ownerId, kind: str(r.TYPE) ?? 'imported', name: ext && !name.toLowerCase().endsWith(`.${ext}`) ? `${name}.${ext}` : name, data, signed: bool(r.SIGNED) });
      w.stat('document').create++;
    }
  }
  return { docs };
}

/** Début / fin locaux (AAAA-MM-JJTHH:MM:SS) d'un créneau MCDF. */
export function slotSpan(r: Row): { start: string; end: string } | null {
  const s = localDateTime(r.START_DATE), e = localDateTime(r.END_DATE);
  const day = date(r.TRAINING_DATE) ?? s?.date ?? null;
  if (!day) return null;
  const st = s?.time ?? null, et = e?.time ?? null;
  if (st && et) {
    const start = `${s!.date}T${st}`, end = `${e!.date ?? day}T${et}`;
    if (end > start) return { start, end };
  }
  const hours = num(r.TOTAL_HOURS);
  if (st && hours && hours > 0) {
    const d = new Date(`${s!.date}T${st}Z`); d.setUTCMinutes(d.getUTCMinutes() + Math.round(hours * 60));
    return { start: `${s!.date}T${st}`, end: d.toISOString().slice(0, 19) };
  }
  if (hours && hours > 0) { // jour sans heures : 09:00 + durée
    const d = new Date(`${day}T09:00:00Z`); d.setUTCMinutes(d.getUTCMinutes() + Math.round(hours * 60));
    return { start: `${day}T09:00:00`, end: d.toISOString().slice(0, 19) };
  }
  return null;
}

function dueDate(issue: string, period: number | null, day: number | null) {
  const d = new Date(`${issue}T00:00:00Z`);
  if (period && period > 0) d.setUTCDate(d.getUTCDate() + period);
  if (day && day > 0 && day <= 31) { if (d.getUTCDate() > day) d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(Math.min(day, 28)); }
  return d.toISOString().slice(0, 10);
}

/** Contenu d'une pièce : DOCUMENT (longblob) sinon CONTENT (base64, éventuellement data:…;base64,). */
function docBytes(r: Row): Buffer | null {
  if (Buffer.isBuffer(r.DOCUMENT) && r.DOCUMENT.length) return r.DOCUMENT;
  const c = str(r.CONTENT);
  if (!c) return null;
  const b64 = c.replace(/^data:[^,]*;base64,/, '').replace(/\s/g, '');
  if (/^[A-Za-z0-9+/]+=*$/.test(b64) && b64.length >= 8) { const b = Buffer.from(b64, 'base64'); if (b.length) return b; }
  return Buffer.from(c, 'utf8');
}

const createdAt = (r: Row) => {
  const d = localDateTime(r.CREATED);
  return d ? `${d.date}T${d.time ?? '00:00:00'}Z` : new Date().toISOString();
};

/** Colonnes reprises en colonne typée (le reste → legacy). */
const USED: Record<string, Set<string>> = Object.fromEntries(Object.entries({
  company: 'ID ENTITY_ID NAME CODE ADDRESS ADDRESS2 ADDRESS3 POSTAL_CODE CITY COUNTRY_ID EMAIL PHONE FAX STAFF_COUNT PAYMENT_PERIOD PAYMENT_DAY BANK IBAN BIC APE SIRET WEBSITE ACTIVATED FINANCER PAYMENT_TYPE_ID ACCOUNT_ACCOUNTING INVOICE_HOURS_MINI INVOICE_AMOUNT_MINI TARIFF_ID PAYMENT_LABEL DUE_ID CAPITAL ACTIVITYAREA_ID INTRA_COMMUNITY_VAT ORIGIN_ID THIRD CUSTOMIZED_ADDITION_FIELD ASP NOTES IMAGE CREATED',
  actor: 'ID ENTITY_ID COMPANY_ID FUNCTION_ID DIPLOMA_ID LEVEL_ID LASTNAME FIRSTNAME CANDIDATE ATTENDEE TRAINER ACCOUNT_MANAGER CONTACT TUTOR ADDRESS ADDRESS2 ADDRESS3 POSTAL_CODE CITY EMAIL FIXED_PHONE CELL_PHONE BIRTH_DATE CIVILITY SEXE BANK IBAN BIC SIRET ENTRY_DATE RELEASE_DATE AS_FUNCTION COUNTRY_ID NATIONALITY_COUNTRY_ID COLOR CONTRACT_TYPE HIRING_DATE INFO ACTIVATED NOTES CUSTOMER CODE PHOTO IMAGE HOURLY_RATE MONTHLY_HOURS MAIDEN_NAME BIRTH_PLACE AVAILIBILITY_DATE ACCOUNT_MANAGER_ID BIRTH_COUNTRY_ID NIGHT_RATE BANK_HOLIDAY_RATE PROFESSION_TITLE PROFESSION_TITLE_NUMBER PROFESSION_TITLE_END_VALIDITY_DATE ORIGIN_ID MANAGER MANAGER_ID ARCHIVED TUTOR_ID EMAIL2 CUSTOMIZED_ADDITION_FIELD KID UNMESSAGABLE ACTIVITY_DECLARATION_NUMBER INSURANCE_COMPANY URSAAF CREATED',
  training: 'ID ENTITY_ID LEVEL_ID DIPLOMA_ID ASSESSMENT_ID COURSE_TYPE_ID DISCIPLINE_ID VAT_ID NAME CODE HOURS DAYS PRICE COLOR EDUCATIONAL UNIT ACCOUNT_ACCOUNTING ACCOUNT_ORGANIZATION SUBCONTRACTOR SUPPORT ACTIVATED NATURE_ID COST BPF BY_HOUR MEAL CERTIFYING FAMILY_ID CREATED',
  room: 'ID ENTITY_ID CODE NAME EXTERNAL UNCONTROLLED ADDRESS ADDRESS2 POSTAL_CODE CITY COUNTRY_ID COLOR ACTIVATED HOURLY_COST CONTACT_NAME CONTACT_PHONE CONTACT_EMAIL LOGISTIC_TYPE_ID',
  convention: 'ID NAME ACTIVATED ENTITY_ID CUSTOMER_ID CODE PROPOSAL_CODE CONTACT_ID ACCOUNT_MANAGER_ID START_DATE END_DATE OPCA_ID IS_CONVENTION PROVISIONAL_DATE SIGNING_DATE PROPOSAL_STATUS CONVENTION_DATE BILLING_DATE CALLING_DATE ATTESTATION_DATE STATEMENT_DATE TRANSFERT_DATE LISTING_DATE NEXT_BILLING_DATE IS_PROPOSAL INVOICED CONVENTION_STATUS CONTRACT_TYPE_ID HOURS INVOICED_HOURS FULFILLED_HOURS HOURS_TO_INVOICE SUPPORT_NUMBER ESTIMATE PATTERN PATTERN_ID MANAGER_ID TITLE REASON COMPETITOR ARCHIVED ORIGIN_ID CUSTOMIZED_ADDITION_FIELD NOTES ATTENDEE_SUPPORT INVOICE_NO_SCHEDULED_EVENT CREATED',
  session: 'ID ENTITY_ID NAME CODE TRAINING_ID START_DATE END_DATE HOURS DAYS HOURLY_RATE DAILY_RATE NUMBER_MINI NUMBER_MAXI TRAINER_ID ROOM_ID ACTIVATED DISCIPLINE_ID START_TIME END_TIME MOTIF WEEK_DAY OUTFIT FEATURE MANAGER_ID OPENED SURBOOKING ARCHIVED CUSTOMIZED_ADDITION_FIELD CREATED',
  schedule: 'ID ACTIVATED SESSION_ID TRAINER_ID ROOM_ID DISCIPLINE_ID TYPE COMMENT ENTITY_ID COLOR CREATED UPDATED',
  invoice: 'ID ENTITY_ID PAYMENT_TYPE_ID CODE CONVENTION_ID PAYER_ID ACCOUNT_ID BILLING_DATE AMOUNT VAT_AMOUNT TTC_AMOUNT HOURS DAYS STATUS CREATED INVOICE_ID PAYMENT_PERIOD PAYMENT_DAY PAYMENT_LABEL DISCOUNTED_AMOUNT SUSPICIOUS DEPOSIT ENTITY_NAME BALANCE PAYMENT_DATE',
}).map(([k, v]) => [k, new Set(v.split(' '))]));
