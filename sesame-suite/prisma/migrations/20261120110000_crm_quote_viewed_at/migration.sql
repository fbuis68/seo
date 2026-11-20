-- Première visite réelle de l'espace client public par le prospect, hors
-- aperçu commercial (cf. GET /crmQuote/public, ?preview=1).
ALTER TABLE "CrmQuote" ADD COLUMN "viewedAt" TIMESTAMP(3);
