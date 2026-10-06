-- OpenData (catalogue public mutualisé, lecture seule), IA, banque, email.

CREATE TABLE opendata_sources (
  code text PRIMARY KEY,
  producer text NOT NULL,
  name text NOT NULL,
  family text NOT NULL,
  url text NOT NULL,
  license text,
  access_mode text NOT NULL,                       -- bulk_file, public_api, not_open
  state text NOT NULL CHECK (state IN ('proposed','awaiting_access','licensed','active','stale','broken','excluded')),
  priority text NOT NULL CHECK (priority IN ('P0','P1','P2')),
  cadence text NOT NULL,
  adapter_version text,
  owner text,
  decision_note text,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  current_snapshot_id uuid
);

CREATE TABLE opendata_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_code text NOT NULL REFERENCES opendata_sources(code),
  checksum text NOT NULL,
  etag text,
  producer_updated_at timestamptz,
  snapshot_date date NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  record_count int NOT NULL,
  status text NOT NULL CHECK (status IN ('validating','published','quarantined','superseded')),
  quarantine_reason text
);

CREATE TABLE public_records (
  source_code text NOT NULL,
  snapshot_id uuid NOT NULL REFERENCES opendata_snapshots(id),
  record_key text NOT NULL,                        -- SIRET, NDA, RNCP..., ID offre
  search_text text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, record_key)
);
CREATE INDEX public_records_key_idx ON public_records (source_code, record_key);

CREATE TABLE enrichment_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  source_code text NOT NULL,
  record_key text NOT NULL,
  source_date timestamptz,
  changes jsonb NOT NULL,                          -- [{field, current, proposed}]
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected','stale')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- IA : connexion fournisseur (BYOK) chiffrée, conversations, propositions d'action.
CREATE TABLE ai_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  provider text NOT NULL CHECK (provider IN ('openai','gemini','mistral','fake')),
  auth_mode text NOT NULL DEFAULT 'api_key' CHECK (auth_mode IN ('api_key','oauth')),
  model text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('user','tenant')),
  owner_user_id uuid,
  secret_enc text NOT NULL,
  key_hint text NOT NULL,                          -- 4 derniers caractères
  monthly_budget_cents int,
  allow_sensitive boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalid','revoked','quota_exceeded')),
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE TABLE ai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  title text,
  purge_after timestamptz NOT NULL DEFAULT now() + interval '90 days',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES ai_connections(tenant_id, id)
);
CREATE TABLE ai_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant','tool')),
  content text NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES ai_conversations(tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid,
  provider text NOT NULL,
  model text NOT NULL,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  estimated_cost_cents numeric(10,4) NOT NULL DEFAULT 0,
  tools jsonb NOT NULL DEFAULT '[]',
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid,
  kind text NOT NULL CHECK (kind IN ('create_session','send_email','reconciliation','document_draft')),
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  basis_versions jsonb NOT NULL DEFAULT '{}',      -- versions des objets lus : détection de changement
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','executed','expired','invalidated','rejected')),
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  confirmed_by uuid,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Banque : lecture seule, transactions brutes versionnées, allocations auditées.
CREATE TABLE bank_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  provider text NOT NULL,
  provider_connection_id text NOT NULL,
  institution text NOT NULL,
  secret_enc text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','reauth_required','revoked','error')),
  consent_expires_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  sync_cursor text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (provider, provider_connection_id)
);
CREATE TABLE bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider_account_id text NOT NULL,
  name text NOT NULL,
  iban_masked text,
  currency char(3) NOT NULL,
  balance numeric(14,2),
  balance_at timestamptz,
  selected boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (connection_id, provider_account_id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES bank_connections(tenant_id, id)
);
CREATE TABLE bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  provider_tx_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','booked','reversed')),
  amount numeric(14,2) NOT NULL,                   -- positif = crédit
  currency char(3) NOT NULL,
  booked_on date,
  value_on date,
  label text NOT NULL,
  counterparty text,
  raw jsonb NOT NULL,
  provider_version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (account_id, provider_tx_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES bank_accounts(tenant_id, id)
);
CREATE TABLE reconciliation_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  validated_by uuid NOT NULL,
  validated_at timestamptz NOT NULL DEFAULT now(),
  reverted_at timestamptz,
  reverted_by uuid,
  FOREIGN KEY (tenant_id, transaction_id) REFERENCES bank_transactions(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payments(tenant_id, id)
);

-- Email : SMTP client, outbox, tentatives.
CREATE TABLE mail_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL DEFAULT 'smtp' CHECK (kind IN ('smtp','imap')),
  host text NOT NULL,
  port int NOT NULL,
  security text NOT NULL CHECK (security IN ('tls','starttls')),
  auth_mode text NOT NULL CHECK (auth_mode IN ('password','oauth2')),
  username text NOT NULL,
  secret_enc text NOT NULL,
  from_email text NOT NULL,
  from_name text,
  reply_to text,
  status text NOT NULL DEFAULT 'untested' CHECK (status IN ('untested','ok','error','disabled')),
  last_test_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE TABLE mail_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  connection_id uuid,                              -- NULL = canal système
  message_id text NOT NULL UNIQUE,                 -- Message-ID stable
  to_addresses text[] NOT NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  body_html text,
  attachments jsonb NOT NULL DEFAULT '[]',         -- [{document_id}]
  related_type text,
  related_id uuid,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','accepted_by_smtp','failed','delivery_unknown','cancelled')),
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE TABLE mail_delivery_attempts (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  message_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text,
  smtp_response text,
  FOREIGN KEY (tenant_id, message_id) REFERENCES mail_messages(tenant_id, id)
);

SELECT enable_tenant_rls(t) FROM unnest(ARRAY[
  'enrichment_proposals','ai_connections','ai_conversations','ai_messages','ai_runs','ai_proposals',
  'bank_connections','bank_accounts','bank_transactions','reconciliation_allocations',
  'mail_connections','mail_messages','mail_delivery_attempts'
]::regclass[]) AS t;
