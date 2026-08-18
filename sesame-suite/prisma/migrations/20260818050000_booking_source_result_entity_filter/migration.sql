-- Filtre de sécurité post-fetch : certaines API "login" à profils multiples
-- (ex: Sesame Technology) ne cloisonnent pas strictement par profil sur
-- tous leurs endpoints — confirmé en pratique sur /wa/booking/list, qui a
-- renvoyé des réservations d'un autre établissement que celui authentifié.
ALTER TABLE "BookingSourceConfig" ADD COLUMN "resultEntityField" TEXT;
