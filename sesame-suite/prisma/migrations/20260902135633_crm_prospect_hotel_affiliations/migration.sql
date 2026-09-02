-- Affiliations hôtelières (marque/enseigne + labels/collections, ex. Best Western,
-- Relais & Châteaux) — liste à choix multiple, sans lien avec le champ "groupe"
-- (exploitant/opérateur). Aucune donnée existante à reprendre : champ neuf.
ALTER TABLE "CrmProspect" ADD COLUMN "affiliations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
