-- Lien session ↔ émargement ↔ facturation.
-- Prix propre à la session (sinon prix du programme) et base de prix.
ALTER TABLE training_sessions
  ADD COLUMN price_ht numeric(14,2) CHECK (price_ht IS NULL OR price_ht >= 0),
  ADD COLUMN price_basis text CHECK (price_basis IN ('per_learner','per_session'));  -- NULL : inter = par apprenant, intra = forfait

-- Ce qui a été facturé pour une session : par inscription, payeur (client ou financeur) et facture.
-- Supprimer un brouillon de facture libère les éléments (cascade) ; une facture entièrement
-- annulée par avoir n'est plus comptée comme facturation.
CREATE TABLE billing_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  enrollment_id uuid,                               -- NULL : forfait intra de la session
  payer_client_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('client','funder')),
  invoice_id uuid NOT NULL,
  amount_ht numeric(14,2) NOT NULL,
  basis text NOT NULL CHECK (basis IN ('flat','hours')),
  attended_minutes int,
  planned_minutes int,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, session_id) REFERENCES training_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, enrollment_id) REFERENCES enrollments(tenant_id, id),
  FOREIGN KEY (tenant_id, payer_client_id) REFERENCES clients(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX billing_items_session_idx ON billing_items (tenant_id, session_id);
SELECT enable_tenant_rls('billing_items');
