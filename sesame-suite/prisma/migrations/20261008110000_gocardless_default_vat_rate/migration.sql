-- AlterTable
-- Taux de TVA par défaut appliqué aux prélèvements GoCardless sans facture correspondante
ALTER TABLE "GoCardlessConfig" ADD COLUMN "vatRate" DOUBLE PRECISION NOT NULL DEFAULT 20;
