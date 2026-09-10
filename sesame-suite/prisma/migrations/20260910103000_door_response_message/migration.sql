-- Dot-path optionnel vers le motif du refus dans la réponse d'ouverture de
-- porte (ex : Sesame /ws/booking/openAs renvoie {"success":false,
-- "message":"..."} en cas de refus logique) — surfacé au personnel au lieu
-- du seul "réponse négative" générique.
ALTER TABLE "BookingSourceConfig" ADD COLUMN "doorResponseMessagePath" TEXT;
