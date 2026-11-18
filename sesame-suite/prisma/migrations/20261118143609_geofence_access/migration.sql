-- "localiser la personne... pour éviter les ouvertures à distance avec le
-- bouton" (18/11/2026) — géorepère optionnel par accès.
ALTER TABLE "Room" ADD COLUMN "geoLat" DOUBLE PRECISION;
ALTER TABLE "Room" ADD COLUMN "geoLng" DOUBLE PRECISION;
ALTER TABLE "Room" ADD COLUMN "geoRadiusMeters" INTEGER;
