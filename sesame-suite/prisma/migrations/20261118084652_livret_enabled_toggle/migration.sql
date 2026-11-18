-- "les options non activées dans l'entité (boutique, livret) ne doivent pas
-- apparaître du tout dans l'espace client" (18/11/2026) — toggle dédié
-- pour le livret digital, qui n'a pas d'entrée dans checkinModules.
ALTER TABLE "EntityModuleConfig" ADD COLUMN "livretEnabled" BOOLEAN NOT NULL DEFAULT true;
