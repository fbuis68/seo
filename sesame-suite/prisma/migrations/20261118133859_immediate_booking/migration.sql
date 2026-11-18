-- "mettre un paramètre fait que la réservation est immédiate" (18/11/2026)
-- — réservation en ligne sans choix de dates, arrivée = maintenant.
ALTER TABLE "BookingEngineConfig" ADD COLUMN "immediateBooking" BOOLEAN NOT NULL DEFAULT false;
