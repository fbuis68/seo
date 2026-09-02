-- Backfill de "affiliations" à partir de "groupe" pour les bases déjà seedées
-- avant l'ajout du champ (le seed lui-même ne se réexécute jamais sur une base
-- non vide, cf. garde `count === 0` dans prisma/seed.ts). "Loc Box" et "LocBox"
-- désignent le même exploitant dans les données importées — normalisés ici.
UPDATE "CrmProspect"
SET "affiliations" = ARRAY[CASE WHEN "groupe" = 'Loc Box' THEN 'LocBox' ELSE "groupe" END]
WHERE "groupe" IS NOT NULL AND "groupe" <> '' AND "affiliations" = ARRAY[]::TEXT[];
