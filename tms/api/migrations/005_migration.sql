-- Reprise par fichiers de sauvegarde uniquement (aucun connecteur API source).

CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_software text NOT NULL,                   -- dendreo, digiforma, generic, native...
  source_instance_id text NOT NULL,                -- compte source déclaré (pas le fichier)
  profile_code text,
  profile_version text,
  profile_confidence numeric(4,2),
  profile_confirmed_at timestamptz,
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN (
    'uploaded','rejected','detected','mapped','simulated','committing','published','rolled_back','failed','cancelled')),
  package_sha256 text,
  package_size bigint,
  mapping jsonb NOT NULL DEFAULT '{}',
  mapping_hash text,
  options jsonb NOT NULL DEFAULT '{}',             -- mode create_only|create_update, partial
  simulation jsonb,
  report jsonb,
  diagnostic jsonb,
  checkpoint jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (tenant_id, id)
);
-- Un seul lot actif par organisme.
CREATE UNIQUE INDEX import_batches_one_active ON import_batches (tenant_id)
  WHERE status IN ('uploaded','detected','mapped','simulated','committing');

CREATE TABLE import_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  path text NOT NULL,
  kind text NOT NULL,                              -- table, document, unknown
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  storage_key text,
  columns text[],
  row_count int,
  FOREIGN KEY (tenant_id, batch_id) REFERENCES import_batches(tenant_id, id)
);

CREATE TABLE import_rows (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  entity_type text NOT NULL,
  file_path text NOT NULL,
  line_no int NOT NULL,
  external_id text,
  data jsonb NOT NULL,
  severity text NOT NULL DEFAULT 'ok' CHECK (severity IN ('ok','info','warning','fix','blocking')),
  issues jsonb NOT NULL DEFAULT '[]',
  planned_action text CHECK (planned_action IN ('create','update','unchanged','reject','exclude')),
  target_id uuid,
  done boolean NOT NULL DEFAULT false,
  FOREIGN KEY (tenant_id, batch_id) REFERENCES import_batches(tenant_id, id)
);
CREATE INDEX import_rows_batch_idx ON import_rows (batch_id, entity_type, line_no);

CREATE TABLE external_identities (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_instance_id text NOT NULL,
  entity_type text NOT NULL,
  external_id text NOT NULL,
  internal_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_instance_id, entity_type, external_id)
);

-- Journal des changements d'un lot : base des compensations (rollback).
CREATE TABLE import_changes (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('create','update')),
  before jsonb,
  after_version int,
  FOREIGN KEY (tenant_id, batch_id) REFERENCES import_batches(tenant_id, id)
);

SELECT enable_tenant_rls(t) FROM unnest(ARRAY[
  'import_batches','import_files','import_rows','external_identities','import_changes'
]::regclass[]) AS t;
