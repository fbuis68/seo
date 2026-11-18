-- "fonction d'anti pass back... activé sur certains accès... paramétré en
-- terme de temps" (18/11/2026) — délai (minutes) avant de pouvoir rouvrir
-- le même accès avec le même code de réservation.
ALTER TABLE "Room" ADD COLUMN "antiPassbackMinutes" INTEGER;
