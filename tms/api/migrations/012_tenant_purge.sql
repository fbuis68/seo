-- Suppression définitive d'un organisme par l'éditeur (comptes de test, demande RGPD) :
-- seule exception, avec la compensation de reprise, à l'immuabilité des factures émises.
-- Activée uniquement dans la transaction de purge (app.tenant_purge = on).
CREATE OR REPLACE FUNCTION forbid_issued_invoice_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'issued' AND NOT (OLD.is_historical AND current_setting('app.import_rollback', true) = 'on')
       AND coalesce(current_setting('app.tenant_purge', true), '') <> 'on' THEN
      RAISE EXCEPTION 'invoice_immutable' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'issued' AND (NEW.kind, NEW.client_id, NEW.status, NEW.series_code, NEW.number, NEW.issue_date,
      NEW.due_date, NEW.currency, NEW.total_ht, NEW.total_vat, NEW.total_ttc, NEW.credited_invoice_id)
      IS DISTINCT FROM (OLD.kind, OLD.client_id, OLD.status, OLD.series_code, OLD.number, OLD.issue_date,
      OLD.due_date, OLD.currency, OLD.total_ht, OLD.total_vat, OLD.total_ttc, OLD.credited_invoice_id)
      AND coalesce(current_setting('app.tenant_purge', true), '') <> 'on' THEN
    RAISE EXCEPTION 'invoice_immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION forbid_issued_invoice_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE st text; hist boolean;
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('app.tenant_purge', true), '') = 'on' THEN RETURN OLD; END IF;
  SELECT status, is_historical INTO st, hist FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF st = 'issued' AND NOT (TG_OP = 'DELETE' AND hist AND current_setting('app.import_rollback', true) = 'on') THEN
    RAISE EXCEPTION 'invoice_immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
