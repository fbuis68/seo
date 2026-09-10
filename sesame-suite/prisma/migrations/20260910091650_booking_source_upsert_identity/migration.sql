-- Identité du client pour l'envoi initial d'une réservation vers la source
-- externe (création côté source si l'endpoint update configuré le permet,
-- ex: /ws/booking/createOrUpdate côté API Sesame Technology) — cf.
-- pushBookingUpsert.
ALTER TABLE "BookingSourceConfig" ADD COLUMN "updateEmailParam" TEXT;
ALTER TABLE "BookingSourceConfig" ADD COLUMN "updateLastnameParam" TEXT;
ALTER TABLE "BookingSourceConfig" ADD COLUMN "updateFirstnameParam" TEXT;
ALTER TABLE "BookingSourceConfig" ADD COLUMN "updatePhoneParam" TEXT;
