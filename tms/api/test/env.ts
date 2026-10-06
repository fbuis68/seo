process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://tms_app:tms_app@localhost:5432/tms_test';
process.env.MIGRATION_DATABASE_URL ??= 'postgres://tms_owner:tms_owner@localhost:5432/tms_test';
process.env.PAYMENT_PROVIDER = 'fake';
process.env.FAKE_PAYMENT_WEBHOOK_SECRET = 'test-secret';
process.env.STORAGE_DIR = require('path').join(require('os').tmpdir(), `tms-test-storage-${process.pid}`);
process.env.ALLOW_PRIVATE_HOSTS = '1';
