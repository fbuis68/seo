-- Données métier : toutes porteuses de tenant_id, RLS forcée, FK composites (tenant_id, id)
-- pour empêcher tout lien inter-organismes.

CREATE TABLE persons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text,                                      -- non unique : emails partagés possibles
  phone text,
  skills text[] NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE TABLE person_roles (
  tenant_id uuid NOT NULL,
  person_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('learner','trainer','contact')),
  PRIMARY KEY (tenant_id, person_id, role),
  FOREIGN KEY (tenant_id, person_id) REFERENCES persons(tenant_id, id)
);

-- Client = personne morale ou physique avec fiche de facturation ; prospect hors compteur Free.
CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('company','person')),
  status text NOT NULL DEFAULT 'prospect' CHECK (status IN ('prospect','customer')),
  is_funder boolean NOT NULL DEFAULT false,
  name text NOT NULL,
  siren text,
  siret text,
  person_id uuid,
  billing_email text,
  billing_address jsonb NOT NULL DEFAULT '{}',
  archived_at timestamptz,                         -- l'archivage ne libère pas de quota
  merged_into_id uuid,                             -- fusion validée de doublon : libère le quota
  deleted_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES persons(tenant_id, id)
);
CREATE INDEX clients_siret_idx ON clients (tenant_id, siret);

CREATE TABLE client_contacts (
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  person_id uuid NOT NULL,
  position text,
  PRIMARY KEY (tenant_id, client_id, person_id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES persons(tenant_id, id)
);

CREATE TABLE programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text,
  title text NOT NULL,
  is_public boolean NOT NULL DEFAULT false,
  rncp_code text,
  rs_code text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- Version immuable dès son utilisation par une session (locked_at).
CREATE TABLE program_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  program_id uuid NOT NULL,
  version int NOT NULL,
  objectives text NOT NULL DEFAULT '',
  prerequisites text NOT NULL DEFAULT '',
  audience text NOT NULL DEFAULT '',
  duration_minutes int NOT NULL CHECK (duration_minutes > 0),
  modality text NOT NULL CHECK (modality IN ('onsite','remote','blended')),
  evaluation text NOT NULL DEFAULT '',
  price_ht numeric(14,2),
  vat_rate numeric(5,2),
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (program_id, version),
  FOREIGN KEY (tenant_id, program_id) REFERENCES programs(tenant_id, id)
);

CREATE OR REPLACE FUNCTION forbid_locked_program_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.locked_at IS NOT NULL AND (NEW.objectives, NEW.prerequisites, NEW.audience, NEW.duration_minutes,
      NEW.modality, NEW.evaluation, NEW.price_ht, NEW.vat_rate)
      IS DISTINCT FROM (OLD.objectives, OLD.prerequisites, OLD.audience, OLD.duration_minutes,
      OLD.modality, OLD.evaluation, OLD.price_ht, OLD.vat_rate) THEN
    RAISE EXCEPTION 'program_version_locked' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER program_versions_immutable BEFORE UPDATE ON program_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_locked_program_version();

CREATE TABLE rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  location text,
  capacity int,
  UNIQUE (tenant_id, id)
);

CREATE TABLE training_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  program_version_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('inter','intra')),
  client_id uuid,                                  -- client intra
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','planned','confirmed','in_progress','completed','archived','cancelled')),
  capacity int CHECK (capacity IS NULL OR capacity > 0),
  timezone text NOT NULL DEFAULT 'Europe/Paris',
  starts_on date,
  ends_on date,
  location text,
  cancel_reason text,
  is_historical boolean NOT NULL DEFAULT false,    -- reprise : exclu des compteurs annuels si terminé
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, program_version_id) REFERENCES program_versions(tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);

CREATE TABLE slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  room_id uuid,
  trainer_id uuid,
  overlap_override_reason text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES training_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, room_id) REFERENCES rooms(tenant_id, id),
  FOREIGN KEY (tenant_id, trainer_id) REFERENCES persons(tenant_id, id),
  CHECK (ends_at > starts_at)
);

CREATE TABLE enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  person_id uuid NOT NULL,
  client_id uuid,                                  -- client facturé (payeur principal)
  status text NOT NULL DEFAULT 'provisional' CHECK (status IN ('provisional','confirmed','cancelled')),
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, session_id, person_id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES training_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES persons(tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id)
);

CREATE TABLE funding_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  funder_client_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'EUR',
  FOREIGN KEY (tenant_id, enrollment_id) REFERENCES enrollments(tenant_id, id),
  FOREIGN KEY (tenant_id, funder_client_id) REFERENCES clients(tenant_id, id)
);

CREATE TABLE attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('present','absent','partial')),
  minutes int NOT NULL CHECK (minutes >= 0),
  method text NOT NULL DEFAULT 'manager' CHECK (method IN ('manager','trainer','learner_link','import')),
  proof jsonb NOT NULL DEFAULT '{}',               -- horodatage, IP, empreinte
  recorded_by uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, enrollment_id, slot_id),
  FOREIGN KEY (tenant_id, enrollment_id) REFERENCES enrollments(tenant_id, id),
  FOREIGN KEY (tenant_id, slot_id) REFERENCES slots(tenant_id, id)
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  owner_type text NOT NULL,
  owner_id uuid,
  kind text NOT NULL,                              -- convention, convocation, attestation, signed_pdf, proof...
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  provenance jsonb NOT NULL DEFAULT '{}',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

SELECT enable_tenant_rls(t) FROM unnest(ARRAY[
  'persons','person_roles','clients','client_contacts','programs','program_versions','rooms',
  'training_sessions','slots','enrollments','funding_allocations','attendance','documents'
]::regclass[]) AS t;
