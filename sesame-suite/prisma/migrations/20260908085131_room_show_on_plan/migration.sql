-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "showOnPlan" BOOLEAN NOT NULL DEFAULT true;

-- Préserve le comportement actuel : les casiers étaient jusqu'ici exclus de
-- la liste "chambre à positionner" du panneau Plan par une règle codée en
-- dur sur type="casier" (cf. prfUnpositionedRooms côté front) — on la
-- traduit ici en donnée pour ne pas faire réapparaître d'un coup tous les
-- casiers existants dans cette liste après la migration.
UPDATE "Room" SET "showOnPlan" = false WHERE "type" = 'casier';
