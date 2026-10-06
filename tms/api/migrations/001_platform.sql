-- Socle plateforme : identités, organismes (tenants), abonnements, quotas, audit, jobs.
-- Ces tables sont "plateforme" : pas de RLS, accès uniquement via les modules Identity/Billing/Audit.

CREATE OR REPLACE FUNCTION app_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Active l'isolation multi-tenant (RLS forcée) sur une table métier portant tenant_id.
CREATE OR REPLACE FUNCTION enable_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', tbl);
END $$;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  email_verified_at timestamptz,
  mfa_enabled boolean NOT NULL DEFAULT false,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  user_agent text
);

CREATE TABLE email_verifications (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  siret text,
  nda text,
  timezone text NOT NULL DEFAULT 'Europe/Paris',
  currency char(3) NOT NULL DEFAULT 'EUR',
  vat_regime text NOT NULL DEFAULT 'to_confirm',  -- aucun statut fiscal supposé
  address jsonb NOT NULL DEFAULT '{}',
  logo_document_id uuid,
  signup_source text,                              -- ex. 'website-embed', 'app'
  signup_intent jsonb,                             -- offre choisie sur le site, proposée après vérification email
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner','manager','trainer','learner','support')),
  extra_permissions text[] NOT NULL DEFAULT '{}',
  revoked_permissions text[] NOT NULL DEFAULT '{}',
  person_id uuid,                                  -- lien formateur/apprenant
  expires_at timestamptz,                          -- accès support temporaire
  justification text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  email text NOT NULL,
  role text NOT NULL,
  person_id uuid,
  token_hash text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz
);

-- Abonnement SaaS : état interne distinct de l'état fournisseur.
CREATE TABLE subscriptions (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  plan_code text NOT NULL DEFAULT 'free',
  billing_interval text CHECK (billing_interval IN ('month','year')),
  status text NOT NULL DEFAULT 'free'
    CHECK (status IN ('free','trialing','active','past_due','read_only','cancelled')),
  provider text,
  provider_customer_id text,
  provider_subscription_id text UNIQUE,
  provider_status text,
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  grace_until timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  pending_change jsonb,                            -- downgrade appliqué à l'échéance {plan, interval, addons}
  read_only_since timestamptz,
  last_provider_event_at timestamptz,
  terms_version text,
  terms_accepted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscription_addons (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  addon_code text NOT NULL,
  quantity int NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, addon_code)
);

CREATE TABLE checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  provider text NOT NULL,
  provider_session_id text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('subscription','signature_pack')),
  plan_code text,
  billing_interval text,
  addons jsonb NOT NULL DEFAULT '[]',
  idempotency_key text NOT NULL UNIQUE,
  url text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','expired')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Webhooks : un identifiant d'événement fournisseur traité une seule fois.
CREATE TABLE billing_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  type text NOT NULL,
  tenant_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  payload jsonb NOT NULL,
  PRIMARY KEY (provider, event_id)
);

-- Compteurs d'usage mensuels/journaliers (emails, IA, recherches OpenData...).
CREATE TABLE usage_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  metric text NOT NULL,
  period text NOT NULL,                            -- '2026-10' ou '2026-10-06'
  value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, metric, period)
);

-- Grand livre des crédits de signature (réservation / débit / libération / achat).
CREATE TABLE credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  credit_type text NOT NULL DEFAULT 'signature_envelope',
  kind text NOT NULL CHECK (kind IN ('reserve','commit','release','purchase')),
  amount int NOT NULL,
  period text NOT NULL,
  envelope_id uuid,
  idempotency_key text NOT NULL UNIQUE,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_tenant_period ON credit_ledger (tenant_id, credit_type, period);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid,
  actor_user_id uuid,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  data jsonb NOT NULL DEFAULT '{}',
  trace_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant_idx ON audit_events (tenant_id, created_at DESC);

-- File de travaux asynchrones (PostgreSQL, SKIP LOCKED) + outbox transactionnelle.
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  dedupe_key text UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs (status, run_at);

-- Résolution webhook → organisme pour les objets fournisseurs (signature, facture électronique, banque)
-- sans lever la RLS des tables métier.
CREATE TABLE provider_refs (
  provider text NOT NULL,
  kind text NOT NULL,
  provider_id text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  entity_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, kind, provider_id)
);
