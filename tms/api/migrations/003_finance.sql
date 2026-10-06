-- Finance : montants en décimales, devise explicite, facture émise immuable,
-- numérotation atomique par organisme et série.

CREATE TABLE invoice_series (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  prefix text NOT NULL,
  next_number bigint NOT NULL DEFAULT 1,
  is_historical boolean NOT NULL DEFAULT false,    -- séries reprises : jamais réutilisées pour émettre
  PRIMARY KEY (tenant_id, code)
);

CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  session_id uuid,
  number text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','refused','expired')),
  currency char(3) NOT NULL DEFAULT 'EUR',
  lines jsonb NOT NULL DEFAULT '[]',
  total_ht numeric(14,2) NOT NULL DEFAULT 0,
  total_vat numeric(14,2) NOT NULL DEFAULT 0,
  total_ttc numeric(14,2) NOT NULL DEFAULT 0,
  valid_until date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id)
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice','deposit','credit_note')),
  client_id uuid NOT NULL,
  session_id uuid,
  program_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued')),
  series_code text,
  number text,
  issue_date date,
  due_date date,
  currency char(3) NOT NULL DEFAULT 'EUR',
  total_ht numeric(14,2) NOT NULL DEFAULT 0,
  total_vat numeric(14,2) NOT NULL DEFAULT 0,
  total_ttc numeric(14,2) NOT NULL DEFAULT 0,
  credited_invoice_id uuid,                        -- avoir -> facture d'origine
  deposit_of_invoice_id uuid,                      -- facture finale -> acomptes déduits
  is_historical boolean NOT NULL DEFAULT false,
  is_incomplete boolean NOT NULL DEFAULT false,    -- reprise incomplète : exclue des agrégats certifiés
  external_ref text,
  einvoice_status text CHECK (einvoice_status IN ('pending','transmitted','rejected','received','accepted','paid')),
  einvoice_provider_id text,
  einvoice_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, series_code, number),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES training_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, credited_invoice_id) REFERENCES invoices(tenant_id, id),
  CHECK (status = 'draft' OR (number IS NOT NULL AND issue_date IS NOT NULL))
);

CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  position int NOT NULL,
  label text NOT NULL,
  quantity numeric(14,4) NOT NULL,
  unit_price_ht numeric(14,4) NOT NULL,
  vat_rate numeric(5,2) NOT NULL,
  total_ht numeric(14,2) NOT NULL,
  total_vat numeric(14,2) NOT NULL,
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id)
);

-- Une facture émise est immuable : seules les colonnes de statut électronique évoluent.
CREATE OR REPLACE FUNCTION forbid_issued_invoice_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Seule exception : compensation d'un lot de reprise (factures historiques uniquement).
    IF OLD.status = 'issued' AND NOT (OLD.is_historical AND current_setting('app.import_rollback', true) = 'on') THEN
      RAISE EXCEPTION 'invoice_immutable' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'issued' AND (NEW.kind, NEW.client_id, NEW.status, NEW.series_code, NEW.number, NEW.issue_date,
      NEW.due_date, NEW.currency, NEW.total_ht, NEW.total_vat, NEW.total_ttc, NEW.credited_invoice_id)
      IS DISTINCT FROM (OLD.kind, OLD.client_id, OLD.status, OLD.series_code, OLD.number, OLD.issue_date,
      OLD.due_date, OLD.currency, OLD.total_ht, OLD.total_vat, OLD.total_ttc, OLD.credited_invoice_id) THEN
    RAISE EXCEPTION 'invoice_immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_immutable BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION forbid_issued_invoice_change();

CREATE OR REPLACE FUNCTION forbid_issued_invoice_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE st text; hist boolean;
BEGIN
  SELECT status, is_historical INTO st, hist FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF st = 'issued' AND NOT (TG_OP = 'DELETE' AND hist AND current_setting('app.import_rollback', true) = 'on') THEN
    RAISE EXCEPTION 'invoice_immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER invoice_lines_immutable BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_issued_invoice_lines();

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL,                   -- négatif = remboursement
  currency char(3) NOT NULL DEFAULT 'EUR',
  received_on date NOT NULL,
  method text NOT NULL DEFAULT 'transfer',
  reference text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','bank','import')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id)
);

CREATE TABLE payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payments(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id)
);

SELECT enable_tenant_rls(t) FROM unnest(ARRAY[
  'invoice_series','quotes','invoices','invoice_lines','payments','payment_allocations'
]::regclass[]) AS t;
