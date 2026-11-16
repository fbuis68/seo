-- Champ "source" renvoyé par l'API externe (booking/expedia/default...),
-- distinct de Booking.importedFrom (16/11/2026, "rajouter et afficher la
-- donnée Source dans les api Sesame").
ALTER TABLE "Booking" ADD COLUMN "source" TEXT;
