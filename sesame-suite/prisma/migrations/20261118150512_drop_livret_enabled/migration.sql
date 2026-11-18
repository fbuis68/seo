-- Livret digital consolidé dans EntityModuleConfig.checkinModules (module
-- standard "livret", même mécanisme que les autres modules) — l'ancien
-- toggle dédié n'est plus lu ni écrit.
ALTER TABLE "EntityModuleConfig" DROP COLUMN "livretEnabled";
