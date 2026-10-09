-- AlterTable
-- Connecteur de push des commandes INDÉPENDANT de celui des réservations —
-- permet d'importer les réservations depuis un système (ex : Sesame
-- Technology) et de pousser les commandes vers un autre (ex : Mews).
ALTER TABLE "BookingSourceConfig" ADD COLUMN "orderBaseUrl" TEXT;
ALTER TABLE "BookingSourceConfig" ADD COLUMN "orderAuthType" TEXT DEFAULT 'none';
ALTER TABLE "BookingSourceConfig" ADD COLUMN "orderAuthApiKeyHeader" TEXT;
ALTER TABLE "BookingSourceConfig" ADD COLUMN "orderAuthApiKeyValue" TEXT;
ALTER TABLE "BookingSourceConfig" ADD COLUMN "orderAuthBearerToken" TEXT;
ALTER TABLE "BookingSourceConfig" ADD COLUMN "orderAuthBasicUser" TEXT;
ALTER TABLE "BookingSourceConfig" ADD COLUMN "orderAuthBasicPassword" TEXT;
