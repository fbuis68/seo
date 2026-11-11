-- Rejoué à chaque migration : droits du rôle applicatif (sans propriété des tables, donc soumis à la RLS).
DO $$
DECLARE app text := coalesce(current_setting('app.db_app_role', true), 'tn_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', app);
    EXECUTE format('REVOKE UPDATE, DELETE ON audit_log FROM %I', app);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', app);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', app);
  END IF;
END $$;
