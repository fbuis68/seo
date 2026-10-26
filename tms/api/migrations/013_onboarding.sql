-- Mise en service : profil de facturation versionné, bascule de numérotation, assistant d'onboarding.

-- Profil de facturation (FAC 01, 02, 05) : chaque modification crée une version non confirmée ;
-- l'émission exige la dernière version confirmée par un utilisateur habilité.
CREATE TABLE billing_profile_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  version int NOT NULL,
  data jsonb NOT NULL,
  -- data : {vatRegime, exemptionReason, vatNumber, pricesBasis ('ht'), rounding ('line'), paymentTermsDays,
  --         paymentMethods[], latePenalty, fixedIndemnity, iban, bic, bankName, showBankDetails, contactEmail, contactPhone, footer}
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by uuid,
  confirmed_at timestamptz,
  UNIQUE (tenant_id, version)
);

-- Numérotation et bascule (FAC 03).
ALTER TABLE invoice_series
  ADD COLUMN legacy_last_number text,              -- dernier numéro émis dans l'ancien outil
  ADD COLUMN cutover_on date,                      -- date de bascule : émission réservée au nouvel outil
  ADD COLUMN confirmed_by uuid,
  ADD COLUMN confirmed_at timestamptz;

-- Rôles du travail partagé (ONB 03) : responsable facturation, chargé de reprise.
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('owner','manager','trainer','learner','support','accountant','importer'));

-- Assistant (ONB 01-05) et jalons.
CREATE TABLE onboarding_sessions (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  path text CHECK (path IN ('start','excel','migrate')),
  answers jsonb NOT NULL DEFAULT '{}',             -- activité, pays, devise, sociétés, outil précédent, volume, objectif
  status text NOT NULL DEFAULT 'new',
  deferred jsonb NOT NULL DEFAULT '[]',            -- étapes optionnelles différées
  first_draft_at timestamptz,                      -- jalon « Première valeur obtenue »
  first_issue_at timestamptz,                      -- jalon « Première facture émise »
  ready_at timestamptz,                            -- jalon « Prêt à facturer »
  complete_at timestamptz,                         -- jalon « Reprise complète »
  closed_at timestamptz,                           -- assistant terminé : relances arrêtées
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  reminders_sent int NOT NULL DEFAULT 0,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE invoices NO FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_series NO FORCE ROW LEVEL SECURITY;
-- Organismes existants qui émettent déjà : profil et séquence réputés validés (pas de blocage rétroactif).
INSERT INTO billing_profile_versions(tenant_id, version, data, confirmed_at)
  SELECT t.id, 1, jsonb_build_object('vatRegime', CASE WHEN t.vat_regime = 'to_confirm' THEN 'subject' ELSE t.vat_regime END,
                                     'pricesBasis', 'ht', 'rounding', 'line', 'paymentTermsDays', 30, 'migrated', true), now()
    FROM tenants t WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.tenant_id = t.id AND i.status = 'issued' AND NOT i.is_historical);
UPDATE invoice_series s SET confirmed_at = now()
  WHERE NOT s.is_historical AND EXISTS (SELECT 1 FROM invoices i WHERE i.tenant_id = s.tenant_id AND i.status = 'issued' AND NOT i.is_historical);

ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_series FORCE ROW LEVEL SECURITY;

SELECT enable_tenant_rls(t) FROM unnest(ARRAY['billing_profile_versions','onboarding_sessions']::regclass[]) AS t;
