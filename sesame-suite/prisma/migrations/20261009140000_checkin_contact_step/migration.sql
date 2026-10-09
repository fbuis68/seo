-- AlterTable
-- Adresse postale + acceptation CGU — étape "Mes coordonnées" du check-in
ALTER TABLE "Booking" ADD COLUMN "personAddress" TEXT;
ALTER TABLE "Booking" ADD COLUMN "personZip" TEXT;
ALTER TABLE "Booking" ADD COLUMN "personCity" TEXT;
ALTER TABLE "Booking" ADD COLUMN "cguAcceptedAt" TIMESTAMP(3);

-- AlterTable
-- Lien CGU/CGV configurable par l'hôtel, affiché à l'étape "Mes coordonnées"
ALTER TABLE "EntityModuleConfig" ADD COLUMN "termsUrl" TEXT;
