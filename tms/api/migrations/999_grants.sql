-- Rôle applicatif sans privilège de contournement RLS (rejoué à chaque migration).
GRANT USAGE ON SCHEMA public TO tms_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tms_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tms_app;
