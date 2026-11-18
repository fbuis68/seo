-- "tick box QR Code / Code / Reconnaissance faciale + paramétrage plus fin
-- sur les accès" (18/11/2026) — méthode(s) d'accès par défaut de
-- l'établissement, et surcharge ponctuelle par chambre/accès.
ALTER TABLE "EntityModuleConfig" ADD COLUMN "accessMethods" JSONB;
ALTER TABLE "Room" ADD COLUMN "accessMethod" TEXT;
