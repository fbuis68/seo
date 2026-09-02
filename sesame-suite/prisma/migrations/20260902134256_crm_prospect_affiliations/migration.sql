-- Groupes d'affiliation multi-établissements (Machefert, LocBox, Village D+, ...),
-- gérés comme liste à choix multiple côté CRM plutôt que le champ libre unique "groupe".
ALTER TABLE "CrmProspect" ADD COLUMN "affiliations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
