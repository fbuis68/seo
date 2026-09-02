-- Affiliations hôtelières confirmées par recherche web croisée (au moins deux
-- sources indépendantes : Booking.com, Hotels.com, HRS, ou classement Logis
-- "cocottes" du restaurant attenant) le 02/09/2026. Seules les 4 fiches ci-
-- dessous ont une affiliation confirmée avec une confiance suffisante parmi
-- les 39 fiches "Hôtellerie"/"Appart Hotel" du portefeuille — les autres
-- n'ont montré aucune affiliation, ou une mention trop faible/isolée pour
-- être fiable (ex. un seul agrégateur non officiel), et restent donc vides
-- plutôt que d'être devinées.
UPDATE "CrmProspect" SET "affiliations" = ARRAY['Logis de France'] WHERE "nom" = 'ASTREA' AND "affiliations" = ARRAY[]::TEXT[];
UPDATE "CrmProspect" SET "affiliations" = ARRAY['Logis de France'] WHERE "nom" = 'AUBERG''INE' AND "affiliations" = ARRAY[]::TEXT[];
UPDATE "CrmProspect" SET "affiliations" = ARRAY['Logis de France'] WHERE "nom" = 'HOTEL DE LA GARE' AND "affiliations" = ARRAY[]::TEXT[];
UPDATE "CrmProspect" SET "affiliations" = ARRAY['Best Western'] WHERE "nom" = 'LOUVRE PIEMONT' AND "affiliations" = ARRAY[]::TEXT[];
