process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://tn_app:tn_app@localhost:5432/tournois_test';
process.env.MIGRATION_DATABASE_URL ??= 'postgres://tn_owner:tn_owner@localhost:5432/tournois_test';
process.env.PLATFORM_ADMINS = 'admin@example.test';
