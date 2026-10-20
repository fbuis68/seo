-- Alignement sur la base MCDF (MariaDB) pour faciliter la reprise.
-- Principe : chaque table MCDF a une table cible ; chaque colonne MCDF a une colonne cible typée
-- ou, à défaut, est conservée telle quelle dans `legacy` (jsonb) : aucune donnée perdue.
-- `legacy_id` = identifiant MCDF d'origine (varchar 20) : réimport idempotent et recherche par n° MCDF.
-- `custom_fields` = CUSTOMIZED_ADDITION_FIELD (champs personnalisés).

-- ─── Référentiels MCDF (absence, vat, payment_type, function, contract_type, diploma, level,
--     discipline, nature, family, origin, course_type, activityarea, locality, logistic_type,
--     cost, due, tariff, assessment, legal, diploma_type, country) ──────────────────────────
CREATE TABLE reference_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL,                              -- nom de la table MCDF d'origine
  code text,
  label text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',                -- ex. vat {rate}, absence {billable}, contract_type {bpf}, due {period, day}
  active boolean NOT NULL DEFAULT true,
  position int,
  legacy_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX reference_values_legacy_uq ON reference_values (tenant_id, kind, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE INDEX reference_values_kind_idx ON reference_values (tenant_id, kind, code);

-- ─── Personnes (actor) ──────────────────────────────────────────────────────
ALTER TABLE person_roles DROP CONSTRAINT IF EXISTS person_roles_role_check;
ALTER TABLE person_roles ADD CONSTRAINT person_roles_role_check
  CHECK (role IN ('learner','trainer','contact','tutor','staff'));   -- tutor = TUTOR ; staff = ACCOUNT_MANAGER / MANAGER

ALTER TABLE persons
  ADD COLUMN legacy_id text,
  ADD COLUMN code text,                            -- CODE
  ADD COLUMN civility text,                        -- CIVILITY (M, MME…)
  ADD COLUMN gender text,                          -- SEXE
  ADD COLUMN maiden_name text,                     -- MAIDEN_NAME
  ADD COLUMN birth_date date,                      -- BIRTH_DATE
  ADD COLUMN birth_place text,                     -- BIRTH_PLACE
  ADD COLUMN birth_country text,                   -- BIRTH_COUNTRY_ID (code pays)
  ADD COLUMN nationality text,                     -- NATIONALITY_COUNTRY_ID (code pays)
  ADD COLUMN mobile text,                          -- CELL_PHONE (phone = FIXED_PHONE)
  ADD COLUMN email2 text,                          -- EMAIL2
  ADD COLUMN address jsonb NOT NULL DEFAULT '{}',  -- {line1, line2, line3, postal_code, city, country}
  ADD COLUMN employer_client_id uuid,              -- COMPANY_ID : entreprise de rattachement
  ADD COLUMN job_title text,                       -- AS_FUNCTION
  ADD COLUMN function_id uuid,                     -- FUNCTION_ID (reference_values function)
  ADD COLUMN level_id uuid,                        -- LEVEL_ID
  ADD COLUMN diploma_id uuid,                      -- DIPLOMA_ID (plus haut diplôme)
  ADD COLUMN origin_id uuid,                       -- ORIGIN_ID (provenance commerciale)
  ADD COLUMN tutor_person_id uuid,                 -- TUTOR_ID
  ADD COLUMN account_manager_person_id uuid,       -- ACCOUNT_MANAGER_ID
  ADD COLUMN manager_person_id uuid,               -- MANAGER_ID
  ADD COLUMN is_candidate boolean NOT NULL DEFAULT false,   -- CANDIDATE
  ADD COLUMN is_minor boolean NOT NULL DEFAULT false,       -- KID
  ADD COLUMN no_messages boolean NOT NULL DEFAULT false,    -- UNMESSAGABLE
  ADD COLUMN color text,                           -- COLOR (planning)
  ADD COLUMN notes text,                           -- NOTES / INFO
  ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN legacy jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN updated_at timestamptz;
ALTER TABLE persons ADD CONSTRAINT persons_employer_fk FOREIGN KEY (tenant_id, employer_client_id) REFERENCES clients(tenant_id, id);
CREATE UNIQUE INDEX persons_legacy_uq ON persons (tenant_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- Profil formateur : champs MCDF de contractualisation et de rémunération.
ALTER TABLE trainer_profiles
  ADD COLUMN hourly_rate numeric(10,4),            -- HOURLY_RATE
  ADD COLUMN night_rate numeric(10,2),             -- NIGHT_RATE
  ADD COLUMN holiday_rate numeric(10,2),           -- BANK_HOLIDAY_RATE
  ADD COLUMN monthly_hours numeric(10,2),          -- MONTHLY_HOURS
  ADD COLUMN contract_type text,                   -- CONTRACT_TYPE
  ADD COLUMN siret text,                           -- SIRET (formateur indépendant)
  ADD COLUMN activity_declaration_number text,     -- ACTIVITY_DECLARATION_NUMBER (NDA)
  ADD COLUMN insurance text,                       -- INSURANCE_COMPANY
  ADD COLUMN urssaf text,                          -- URSAAF
  ADD COLUMN iban text,                            -- IBAN / BIC / BANK : paiement des vacations
  ADD COLUMN bic text,
  ADD COLUMN bank text,
  ADD COLUMN hired_on date,                        -- HIRING_DATE / ENTRY_DATE
  ADD COLUMN left_on date,                         -- RELEASE_DATE
  ADD COLUMN available_from date,                  -- AVAILIBILITY_DATE
  ADD COLUMN professional_card jsonb;              -- PROFESSION_TITLE, _NUMBER, _END_VALIDITY_DATE

-- Compétences, diplômes et expériences (actor_discipline, actor_diploma, skillful, user_diploma).
CREATE TABLE person_qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  person_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('discipline','diploma','experience')),
  reference_id uuid,                               -- discipline ou diplôme (reference_values)
  level_id uuid,
  label text,                                      -- skillful.NAME / OTHER_DIPLOMA
  organisation text,                               -- skillful.COMPANY
  starts_on date,
  ends_on date,
  delivered_on date,                               -- DIPLOMA_DELIVERY_DATE
  valid_until date,                                -- DIPLOMA_VALIDITY_END_DATE / VALIDATING_END_DATE
  recycling_on date,                               -- RECYCLING_DATE
  mark numeric(10,3),
  validated boolean,
  comment text,
  legacy_id text,
  legacy jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES persons(tenant_id, id)
);
CREATE INDEX person_qualifications_person_idx ON person_qualifications (tenant_id, person_id);
CREATE UNIQUE INDEX person_qualifications_legacy_uq ON person_qualifications (tenant_id, kind, legacy_id) WHERE legacy_id IS NOT NULL;

-- ─── Clients et financeurs (company ; customer = client particulier ou entreprise) ─
ALTER TABLE clients
  ADD COLUMN legacy_id text,
  ADD COLUMN code text,                            -- CODE
  ADD COLUMN phone text,
  ADD COLUMN fax text,
  ADD COLUMN website text,
  ADD COLUMN ape text,                             -- APE
  ADD COLUMN vat_number text,                      -- INTRA_COMMUNITY_VAT
  ADD COLUMN staff_count int,                      -- STAFF_COUNT
  ADD COLUMN capital numeric(14,2),                -- CAPITAL
  ADD COLUMN activity_area_id uuid,                -- ACTIVITYAREA_ID
  ADD COLUMN origin_id uuid,                       -- ORIGIN_ID
  ADD COLUMN account_manager_person_id uuid,       -- ACCOUNT_MANAGER_ID
  ADD COLUMN manager_person_id uuid,               -- MANAGER_ID
  ADD COLUMN payment_method text,                  -- PAYMENT_TYPE_ID (code)
  ADD COLUMN payment_terms jsonb,                  -- {period, day, label, due} (PAYMENT_PERIOD, PAYMENT_DAY, PAYMENT_LABEL, DUE_ID)
  ADD COLUMN accounting_account text,              -- ACCOUNT_ACCOUNTING
  ADD COLUMN third_party_code text,                -- THIRD
  ADD COLUMN iban text,
  ADD COLUMN bic text,
  ADD COLUMN bank text,
  ADD COLUMN tariff_id uuid,                       -- TARIFF_ID
  ADD COLUMN is_asp boolean NOT NULL DEFAULT false,         -- ASP
  ADD COLUMN min_invoice jsonb,                    -- {hours, amount} (INVOICE_HOURS_MINI, INVOICE_AMOUNT_MINI)
  ADD COLUMN notes text,
  ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN legacy jsonb NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX clients_legacy_uq ON clients (tenant_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- Contacts d'entreprise (actor_company) : destinataire des factures.
ALTER TABLE client_contacts ADD COLUMN receives_invoices boolean NOT NULL DEFAULT false;

-- ─── Formations (training) ──────────────────────────────────────────────────
ALTER TABLE programs
  ADD COLUMN legacy_id text,
  ADD COLUMN color text,                           -- COLOR
  ADD COLUMN unit text,                            -- UNIT (heure, jour, forfait…)
  ADD COLUMN days numeric(14,4),                   -- DAYS (HOURS → program_versions.duration_minutes)
  ADD COLUMN cost numeric(14,4),                   -- COST
  ADD COLUMN family_id uuid,                       -- FAMILY_ID
  ADD COLUMN nature_id uuid,                       -- NATURE_ID
  ADD COLUMN discipline_id uuid,                   -- DISCIPLINE_ID
  ADD COLUMN level_id uuid,                        -- LEVEL_ID
  ADD COLUMN diploma_id uuid,                      -- DIPLOMA_ID
  ADD COLUMN course_type_id uuid,                  -- COURSE_TYPE_ID
  ADD COLUMN assessment_id uuid,                   -- ASSESSMENT_ID
  ADD COLUMN is_educational boolean,               -- EDUCATIONAL
  ADD COLUMN is_certifying boolean,                -- CERTIFYING
  ADD COLUMN in_bpf boolean,                       -- BPF
  ADD COLUMN by_hour boolean,                      -- BY_HOUR
  ADD COLUMN with_meal boolean,                    -- MEAL
  ADD COLUMN subcontractor text,                   -- SUBCONTRACTOR
  ADD COLUMN support text,                         -- SUPPORT
  ADD COLUMN accounting_account text,              -- ACCOUNT_ACCOUNTING
  ADD COLUMN accounting_organisation text,         -- ACCOUNT_ORGANIZATION
  ADD COLUMN legacy jsonb NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX programs_legacy_uq ON programs (tenant_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- Grilles tarifaires (tariff + tariff_training).
CREATE TABLE tariff_prices (
  tenant_id uuid NOT NULL,
  tariff_id uuid NOT NULL,
  program_id uuid NOT NULL,
  price_ht numeric(14,4) NOT NULL,
  legacy_id text,
  PRIMARY KEY (tenant_id, tariff_id, program_id),
  FOREIGN KEY (tenant_id, tariff_id) REFERENCES reference_values(tenant_id, id),
  FOREIGN KEY (tenant_id, program_id) REFERENCES programs(tenant_id, id)
);

-- ─── Salles (room) ──────────────────────────────────────────────────────────
ALTER TABLE resources
  ADD COLUMN legacy_id text,
  ADD COLUMN code text,                            -- CODE
  ADD COLUMN color text,                           -- COLOR
  ADD COLUMN hourly_cost numeric(10,2),            -- HOURLY_COST
  ADD COLUMN is_external boolean NOT NULL DEFAULT false,    -- EXTERNAL
  ADD COLUMN uncontrolled boolean NOT NULL DEFAULT false,   -- UNCONTROLLED : pas de contrôle de conflit
  ADD COLUMN postal_address jsonb NOT NULL DEFAULT '{}',    -- {line1, line2, postal_code, city, country}
  ADD COLUMN contact jsonb,                        -- {name, phone, email}
  ADD COLUMN logistic_type_id uuid,                -- LOGISTIC_TYPE_ID
  ADD COLUMN legacy jsonb NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX resources_legacy_uq ON resources (tenant_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- ─── Sessions (session) ─────────────────────────────────────────────────────
ALTER TABLE training_sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE training_sessions
  ADD COLUMN legacy_id text,
  ADD COLUMN hourly_rate numeric(14,4),            -- HOURLY_RATE
  ADD COLUMN daily_rate numeric(14,4),             -- DAILY_RATE
  ADD COLUMN planned_days numeric(14,4),           -- DAYS (HOURS → target_minutes)
  ADD COLUMN default_trainer_id uuid,              -- TRAINER_ID
  ADD COLUMN default_room_id uuid,                 -- ROOM_ID
  ADD COLUMN manager_person_id uuid,               -- MANAGER_ID
  ADD COLUMN discipline_id uuid,                   -- DISCIPLINE_ID
  ADD COLUMN default_times jsonb,                  -- {start, end, week_days} (START_TIME, END_TIME, WEEK_DAY)
  ADD COLUMN registrations_open boolean,           -- OPENED
  ADD COLUMN overbooking boolean,                  -- SURBOOKING
  ADD COLUMN motive text,                          -- MOTIF
  ADD COLUMN outfit text,                          -- OUTFIT (tenue)
  ADD COLUMN features text,                        -- FEATURE
  ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN legacy jsonb NOT NULL DEFAULT '{}';
ALTER TABLE training_sessions FORCE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX training_sessions_legacy_uq ON training_sessions (tenant_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- ─── Créneaux (schedule ; schedule_room = salles multiples → slot_resources) ─
ALTER TABLE slots NO FORCE ROW LEVEL SECURITY;
ALTER TABLE slots
  ADD COLUMN legacy_id text,
  ADD COLUMN color text,                           -- COLOR
  ADD COLUMN discipline_id uuid,                   -- DISCIPLINE_ID
  ADD COLUMN kind text,                            -- TYPE
  ADD COLUMN legacy jsonb NOT NULL DEFAULT '{}';   -- STATUS, ASP, CONSTR_ID, OLD_START/END_DATE…
ALTER TABLE slots FORCE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX slots_legacy_uq ON slots (tenant_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- ─── Conventions / propositions (convention) ────────────────────────────────
CREATE TABLE conventions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legacy_id text,
  code text,                                       -- CODE (n° de convention)
  proposal_code text,                              -- PROPOSAL_CODE (n° de proposition / devis)
  name text,                                       -- NAME
  title text,                                      -- TITLE
  client_id uuid,                                  -- customer_id
  contact_person_id uuid,                          -- CONTACT_ID
  account_manager_person_id uuid,                  -- ACCOUNT_MANAGER_ID
  manager_person_id uuid,                          -- MANAGER_ID
  funder_client_id uuid,                           -- OPCA_ID (financeur principal ; autres : convention_payers)
  is_proposal boolean NOT NULL DEFAULT false,      -- IS_PROPOSAL
  is_convention boolean NOT NULL DEFAULT false,    -- IS_CONVENTION
  proposal_status text,                            -- PROPOSAL_STATUS
  status text,                                     -- CONVENTION_STATUS
  contract_type_id uuid,                           -- CONTRACT_TYPE_ID (BPF ; autres : convention_contract_type)
  contract_type_ids uuid[] NOT NULL DEFAULT '{}',
  starts_on date,                                  -- START_DATE
  ends_on date,                                    -- END_DATE
  dates jsonb NOT NULL DEFAULT '{}',               -- listing, provisional, signing, convention, billing, calling, attestation, statement, transfert, next_billing
  hours numeric(10,2),                             -- HOURS
  invoiced_hours numeric(10,2),                    -- INVOICED_HOURS
  fulfilled_hours numeric(10,2),                   -- FULFILLED_HOURS
  hours_to_invoice numeric(10,2),                  -- HOURS_TO_INVOICE
  estimate numeric(14,2),                          -- ESTIMATE
  support_number text,                             -- SUPPORT_NUMBER (n° de dossier financeur)
  reason text,                                     -- REASON
  competitor text,                                 -- COMPETITOR
  origin_id uuid,                                  -- ORIGIN_ID
  is_template boolean NOT NULL DEFAULT false,      -- PATTERN
  template_id uuid,                                -- PATTERN_ID
  invoiced boolean NOT NULL DEFAULT false,         -- INVOICED
  attendee_support boolean,                        -- ATTENDEE_SUPPORT
  invoice_unscheduled boolean,                     -- INVOICE_NO_SCHEDULED_EVENT
  active boolean NOT NULL DEFAULT true,            -- ACTIVATED
  archived_at timestamptz,                         -- ARCHIVED
  notes text,
  custom_fields jsonb NOT NULL DEFAULT '{}',
  legacy jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id),
  FOREIGN KEY (tenant_id, funder_client_id) REFERENCES clients(tenant_id, id),
  FOREIGN KEY (tenant_id, contact_person_id) REFERENCES persons(tenant_id, id)
);
CREATE UNIQUE INDEX conventions_legacy_uq ON conventions (tenant_id, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE INDEX conventions_client_idx ON conventions (tenant_id, client_id);

-- Lignes de formation de la convention (convention_training).
CREATE TABLE convention_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  convention_id uuid NOT NULL,
  program_id uuid,                                 -- TRAINING_ID
  session_id uuid,                                 -- session_id
  payer_client_id uuid,                            -- PAYER_ID
  position int,                                    -- SEQUENCE
  unit_price_ht numeric(14,4),                     -- PRICE
  quantity numeric(14,4),                          -- QUANTITY
  amount_ht numeric(14,4),                         -- AMOUNT
  discount numeric(10,4),                          -- DISCOUNT
  vat_rate numeric(5,2),                           -- VAT_RATE (VAT_ID → data)
  installments int,                                -- TIMETABLE_COUNT
  status text,                                     -- STATUS
  invoiced boolean NOT NULL DEFAULT false,         -- INVOICED
  is_certifying boolean,                           -- CERTIFYING
  subcontracted text,                              -- SUBCONTRACTED
  comment text,                                    -- COMMENT
  proposal_comment text,                           -- PROPOSAL_COMMENT
  legacy_id text,
  legacy jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, convention_id) REFERENCES conventions(tenant_id, id),
  FOREIGN KEY (tenant_id, program_id) REFERENCES programs(tenant_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES training_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, payer_client_id) REFERENCES clients(tenant_id, id)
);
CREATE INDEX convention_lines_conv_idx ON convention_lines (tenant_id, convention_id);
CREATE UNIQUE INDEX convention_lines_legacy_uq ON convention_lines (tenant_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- Financeurs additionnels (convention_payer).
CREATE TABLE convention_payers (
  tenant_id uuid NOT NULL,
  convention_id uuid NOT NULL,
  client_id uuid NOT NULL,
  legacy_id text,
  PRIMARY KEY (tenant_id, convention_id, client_id),
  FOREIGN KEY (tenant_id, convention_id) REFERENCES conventions(tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id)
);

-- Stagiaires de la convention (convention_attendee) ; l'affectation à une session
-- (convention_attendee_session) devient une inscription liée à la convention.
CREATE TABLE convention_attendees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  convention_id uuid NOT NULL,
  person_id uuid NOT NULL,
  objective text,                                  -- OBJECTIF
  active boolean NOT NULL DEFAULT true,
  legacy_id text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, convention_id, person_id),
  FOREIGN KEY (tenant_id, convention_id) REFERENCES conventions(tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES persons(tenant_id, id)
);

-- Échéancier (timetable) : échéances de facturation d'une ligne de convention.
CREATE TABLE convention_installments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  convention_line_id uuid NOT NULL,
  payer_client_id uuid,                            -- PAYER_ID
  payment_method text,                             -- PAYMENT_TYPE_ID
  billing_on date,                                 -- BILLING_DATE
  quantity numeric(14,4),
  unit_price_ht numeric(14,4),
  amount_ht numeric(14,4),                         -- DISCOUNTED_AMOUNT
  invoice_line_id uuid,                            -- INVOICE_LINE_ID : échéance facturée
  subcontracted text,
  legacy_id text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, convention_line_id) REFERENCES convention_lines(tenant_id, id),
  FOREIGN KEY (tenant_id, payer_client_id) REFERENCES clients(tenant_id, id)
);

-- Rémunération / commission commerciale (actor_convention, commission).
CREATE TABLE convention_staff (
  tenant_id uuid NOT NULL,
  convention_id uuid NOT NULL,
  person_id uuid NOT NULL,
  hourly_rate numeric(10,2),
  commission_pct numeric(5,2),
  legacy_id text,
  PRIMARY KEY (tenant_id, convention_id, person_id),
  FOREIGN KEY (tenant_id, convention_id) REFERENCES conventions(tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES persons(tenant_id, id)
);

-- Frais de session (cost + costs).
CREATE TABLE session_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  session_id uuid,
  convention_id uuid,
  trainer_person_id uuid,
  cost_type_id uuid,                               -- COST_ID (reference_values cost)
  spent_on date,                                   -- DATE_COSTS
  amount numeric(10,2) NOT NULL,
  legacy_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES training_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, convention_id) REFERENCES conventions(tenant_id, id)
);

-- Inscriptions : lien convention, objectif individuel.
ALTER TABLE enrollments
  ADD COLUMN legacy_id text,
  ADD COLUMN convention_id uuid,
  ADD COLUMN objective text;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_convention_fk FOREIGN KEY (tenant_id, convention_id) REFERENCES conventions(tenant_id, id);
CREATE UNIQUE INDEX enrollments_legacy_uq ON enrollments (tenant_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- ─── Émargement (attendee_schedule ; actor_schedule pour le formateur) ──────
ALTER TABLE attendance
  ADD COLUMN legacy_id text,
  ADD COLUMN absence_reason_id uuid,               -- ABSENCE_ID (reference_values absence)
  ADD COLUMN billable boolean,                     -- BILLABLE
  ADD COLUMN comment text;
CREATE UNIQUE INDEX attendance_legacy_uq ON attendance (tenant_id, legacy_id) WHERE legacy_id IS NOT NULL;

CREATE TABLE trainer_attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  person_id uuid NOT NULL,
  present boolean NOT NULL DEFAULT true,           -- NOT MISSING
  billable boolean,
  absence_reason_id uuid,
  comment text,
  signature_ref text,                              -- SIGNATURE_ID
  legacy_id text,
  UNIQUE (tenant_id, slot_id, person_id),
  FOREIGN KEY (tenant_id, slot_id) REFERENCES slots(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, person_id) REFERENCES persons(tenant_id, id)
);

-- ─── Facturation (invoice, invoice_line, invoice_attendee, payment, payment_invoice) ─
ALTER TABLE invoices
  ADD COLUMN legacy_id text,
  ADD COLUMN convention_id uuid,                   -- CONVENTION_ID
  ADD COLUMN payer_snapshot jsonb,                 -- PAYER_* : coordonnées du payeur figées à l'émission
  ADD COLUMN account_snapshot jsonb,               -- ACCOUNT_* : client bénéficiaire
  ADD COLUMN contact_snapshot jsonb,               -- CONTACT_*
  ADD COLUMN convention_snapshot jsonb,            -- CONVENTION_CODE, _START/END_DATE, _SUPPORT_NUMBER, _NAME…
  ADD COLUMN hours numeric(14,4),                  -- HOURS
  ADD COLUMN days numeric(14,4),                   -- DAYS
  ADD COLUMN deposit numeric(14,2),                -- DEPOSIT
  ADD COLUMN discounted_amount numeric(14,2),      -- DISCOUNTED_AMOUNT
  ADD COLUMN payment_method text,                  -- PAYMENT_TYPE_ID
  ADD COLUMN payment_terms jsonb,                  -- {period, day, label}
  ADD COLUMN legacy_status text,                   -- STATUS d'origine
  ADD COLUMN suspicious boolean NOT NULL DEFAULT false,     -- SUSPICIOUS (litige)
  ADD COLUMN legacy jsonb NOT NULL DEFAULT '{}';
ALTER TABLE invoices ADD CONSTRAINT invoices_convention_fk FOREIGN KEY (tenant_id, convention_id) REFERENCES conventions(tenant_id, id);
CREATE UNIQUE INDEX invoices_legacy_uq ON invoices (tenant_id, legacy_id) WHERE legacy_id IS NOT NULL;

ALTER TABLE invoice_lines
  ADD COLUMN legacy_id text,
  ADD COLUMN program_id uuid,                      -- TRAINING_ID
  ADD COLUMN session_id uuid,                      -- SESSION_ID
  ADD COLUMN convention_line_id uuid,              -- CONVENTION_TRAINING_ID
  ADD COLUMN hours numeric(14,4),                  -- HOURS
  ADD COLUMN discount_amount numeric(14,4),        -- AMOUNT_DISCOUNT
  ADD COLUMN snapshot jsonb;                       -- TRAINING_CODE, SESSION_CODE/NAME, TRAINER_NAME, CONVENTION_*

CREATE TABLE invoice_attendees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  person_id uuid,
  snapshot jsonb NOT NULL DEFAULT '{}',            -- nom, fonction, entreprise, adresse au moment de la facture
  legacy_id text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES persons(tenant_id, id)
);

ALTER TABLE payments
  ADD COLUMN legacy_id text,
  ADD COLUMN deposit_slip_ref text,                -- PRESENTATION_CODE (bordereau de remise)
  ADD COLUMN deposit_slip_on date;                 -- PRESENTATION_DATE
CREATE UNIQUE INDEX payments_legacy_uq ON payments (tenant_id, legacy_id) WHERE legacy_id IS NOT NULL;
ALTER TABLE payment_allocations ADD COLUMN legacy_id text;

-- ─── Documents (actor_document, company_document, convention_document, session_document,
--     training_document, schedule_document, message_document) ────────────────────────────
ALTER TABLE documents
  ADD COLUMN legacy_id text,
  ADD COLUMN signed boolean;                       -- SIGNED
CREATE UNIQUE INDEX documents_legacy_uq ON documents (tenant_id, (provenance->>'table'), legacy_id) WHERE legacy_id IS NOT NULL;

SELECT enable_tenant_rls(t) FROM unnest(ARRAY[
  'reference_values','person_qualifications','tariff_prices','conventions','convention_lines','convention_payers',
  'convention_attendees','convention_installments','convention_staff','session_costs','trainer_attendance','invoice_attendees'
]::regclass[]) AS t;
