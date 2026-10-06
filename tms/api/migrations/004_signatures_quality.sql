CREATE TABLE signature_envelopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  document_sha256 text NOT NULL,                   -- version figée envoyée
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','queued','sent','partially_signed','completed_pending_archive','completed',
    'refused','expired','cancelled','failed')),
  provider text NOT NULL,
  provider_id text UNIQUE,
  provider_status text,
  idempotency_key text NOT NULL UNIQUE,
  signed_document_id uuid,
  proof_document_id uuid,
  expires_at timestamptz,
  is_historical boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id)
);
CREATE TABLE signature_signers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  envelope_id uuid NOT NULL,
  full_name text NOT NULL,
  email text NOT NULL,
  role text,
  position int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','signed','refused')),
  signed_at timestamptz,
  refusal_reason text,
  FOREIGN KEY (tenant_id, envelope_id) REFERENCES signature_envelopes(tenant_id, id)
);
-- Webhooks signature : dédupliqués, sans RLS (tenant résolu via provider_id).
CREATE TABLE signature_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  provider_envelope_id text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE questionnaires (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('satisfaction','evaluation','cold')),
  title text NOT NULL,
  questions jsonb NOT NULL,
  UNIQUE (tenant_id, id)
);
CREATE TABLE questionnaire_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  questionnaire_id uuid NOT NULL,
  session_id uuid NOT NULL,
  enrollment_id uuid,
  answers jsonb NOT NULL,
  score numeric(5,2),
  is_imported_summary boolean NOT NULL DEFAULT false,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, questionnaire_id) REFERENCES questionnaires(tenant_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES training_sessions(tenant_id, id)
);
CREATE TABLE complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  session_id uuid,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','closed')),
  action_plan text,
  created_at timestamptz NOT NULL DEFAULT now()
);

SELECT enable_tenant_rls(t) FROM unnest(ARRAY[
  'signature_envelopes','signature_signers','questionnaires','questionnaire_responses','complaints'
]::regclass[]) AS t;
