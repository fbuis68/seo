ALTER TABLE "BookingSourceConfig" ADD COLUMN "loginBodyFormat" TEXT DEFAULT 'json';
ALTER TABLE "BookingSourceConfig" ADD COLUMN "loginCredentialsIn" TEXT DEFAULT 'body';
ALTER TABLE "BookingSourceConfig" ADD COLUMN "loginExtraParams" JSONB;
