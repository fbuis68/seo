-- Simplifie le module Trésorerie : supprime le détail par client/fournisseur
-- ("signe", "pipeline") et repart sur deux catégories génériques récurrentes
-- ("revenu", "depense"), sur demande explicite du 20/08/2026. Les données
-- existantes de ces trois catégories ne correspondent plus au nouveau
-- modèle (pas de client/fréquence) : supprimées (dépenses explicitement,
-- signé/pipeline sur confirmation — le solde de départ est conservé).
DELETE FROM "CrmCashLine" WHERE kind IN ('depense', 'signe', 'pipeline');

-- Retire le lien par client/prospect (fait disparaître la contrainte avant
-- la colonne) et la probabilité (n'existait que pour "pipeline", supprimé).
ALTER TABLE "CrmCashLine" DROP CONSTRAINT IF EXISTS "CrmCashLine_prospectId_fkey";
ALTER TABLE "CrmCashLine" DROP COLUMN IF EXISTS "prospectId";
ALTER TABLE "CrmCashLine" DROP COLUMN IF EXISTS "proba";

-- Fréquence de récurrence des nouvelles lignes "revenu"/"depense".
ALTER TABLE "CrmCashLine" ADD COLUMN "frequence" TEXT;

-- Bascule saisie globale/détaillée par catégorie et par année.
CREATE TABLE "CrmCashSettings" (
    "id" TEXT NOT NULL,
    "annee" INTEGER NOT NULL,
    "revenuMode" TEXT NOT NULL DEFAULT 'detail',
    "revenuMontant" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "revenuFrequence" TEXT NOT NULL DEFAULT 'mensuel',
    "revenuMois" INTEGER,
    "depenseMode" TEXT NOT NULL DEFAULT 'detail',
    "depenseMontant" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "depenseFrequence" TEXT NOT NULL DEFAULT 'mensuel',
    "depenseMois" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmCashSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CrmCashSettings_annee_key" ON "CrmCashSettings"("annee");
