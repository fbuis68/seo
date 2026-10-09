-- AlterTable
-- Correspondance produit boutique/room-service <-> code produit côté PMS (ex : Mews)
ALTER TABLE "Product" ADD COLUMN "pmsProductCode" TEXT;

-- AlterTable
-- Identifiant du compte/dossier de facturation côté PMS pour une réservation (ex : AccountId Mews)
ALTER TABLE "Booking" ADD COLUMN "externalAccountId" TEXT;

-- AlterTable
-- Push des commandes boutique/room-service vers le PMS
ALTER TABLE "BookingSourceConfig" ADD COLUMN "orderPushEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BookingSourceConfig" ADD COLUMN "orderEndpointPath" TEXT;
ALTER TABLE "BookingSourceConfig" ADD COLUMN "orderEndpointMethod" TEXT DEFAULT 'POST';
ALTER TABLE "BookingSourceConfig" ADD COLUMN "orderEndpointBodyParams" JSONB;
ALTER TABLE "BookingSourceConfig" ADD COLUMN "orderServiceIdValue" TEXT;

-- AlterTable
-- Avertissement best-effort si le push de la commande vers le PMS échoue
ALTER TABLE "Order" ADD COLUMN "pmsPushWarning" TEXT;
