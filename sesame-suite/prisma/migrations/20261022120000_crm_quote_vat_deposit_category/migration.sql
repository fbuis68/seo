-- Devis — TVA, acompte, catégorie produit, envoi par email (22/10/2026).

ALTER TABLE "CrmProduct" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'materiel';

ALTER TABLE "CrmQuote" ADD COLUMN "vatPct" DOUBLE PRECISION NOT NULL DEFAULT 20;
ALTER TABLE "CrmQuote" ADD COLUMN "depositPct" DOUBLE PRECISION NOT NULL DEFAULT 0;
