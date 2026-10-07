-- AlterTable
-- Fréquence (mensuel/trimestriel/annuel) et qualification depuis une facture
-- (en plus d'une transaction bancaire) — module Trésorerie, phase 2 suite
ALTER TABLE "AccRecurringRule" ADD COLUMN "sourceInvoiceId" TEXT;
ALTER TABLE "AccRecurringRule" ADD COLUMN "frequency" TEXT NOT NULL DEFAULT 'monthly';
