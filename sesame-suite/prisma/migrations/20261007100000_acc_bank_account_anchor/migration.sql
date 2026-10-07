-- AlterTable
-- Solde d'ancrage par compte bancaire (module Trésorerie, cahier des charges §6.2)
ALTER TABLE "AccBankAccount" ADD COLUMN "anchorBalance" DOUBLE PRECISION;
ALTER TABLE "AccBankAccount" ADD COLUMN "anchorDate" TIMESTAMP(3);
