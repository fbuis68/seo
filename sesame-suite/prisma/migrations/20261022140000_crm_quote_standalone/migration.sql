-- Devis en écran à part entière (22/10/2026) — plus rattaché obligatoirement
-- à une affaire : dealId devient optionnel, prospectId (client direct)
-- devient le lien principal. Backfill des devis existants depuis leur
-- affaire avant de poser la contrainte NOT NULL sur prospectId.

ALTER TABLE "CrmQuote" DROP CONSTRAINT "CrmQuote_dealId_fkey";
ALTER TABLE "CrmQuote" ALTER COLUMN "dealId" DROP NOT NULL;
ALTER TABLE "CrmQuote" ADD CONSTRAINT "CrmQuote_dealId_fkey"
  FOREIGN KEY ("dealId") REFERENCES "CrmDeal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CrmQuote" ADD COLUMN "prospectId" TEXT;
UPDATE "CrmQuote" q SET "prospectId" = d."prospectId"
  FROM "CrmDeal" d WHERE d.id = q."dealId" AND q."prospectId" IS NULL;
-- Filet de sécurité : un devis orphelin (affaire déjà supprimée) ne doit pas
-- bloquer la migration — rattaché au premier client CRM trouvé plutôt que
-- d'échouer, cas purement théorique en pratique (CrmDeal -> CrmQuote est en
-- CASCADE côté affaire, un devis ne peut normalement pas survivre à la
-- suppression de son affaire).
UPDATE "CrmQuote" SET "prospectId" = (SELECT id FROM "CrmProspect" ORDER BY "createdAt" ASC LIMIT 1)
  WHERE "prospectId" IS NULL;
ALTER TABLE "CrmQuote" ALTER COLUMN "prospectId" SET NOT NULL;
ALTER TABLE "CrmQuote" ADD CONSTRAINT "CrmQuote_prospectId_fkey"
  FOREIGN KEY ("prospectId") REFERENCES "CrmProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CrmQuote" ADD COLUMN "title" TEXT NOT NULL DEFAULT '';
ALTER TABLE "CrmQuote" ADD COLUMN "config" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "CrmQuote" ADD COLUMN "introText" TEXT;
ALTER TABLE "CrmQuote" ADD COLUMN "mentionsText" TEXT;
ALTER TABLE "CrmQuote" ADD COLUMN "termsText" TEXT;

-- Reprend le titre de l'affaire comme objet du devis pour les devis
-- existants (évite un "Objet du devis" vide sur l'historique).
UPDATE "CrmQuote" q SET "title" = d."title"
  FROM "CrmDeal" d WHERE d.id = q."dealId" AND q."title" = '';
