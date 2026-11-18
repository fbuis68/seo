-- "demande à effet immédiat en terme de heure minute seconde" (18/11/2026)
-- — affine immediateBooking : arrivée = instant exact (H:M:S), pas minuit.
ALTER TABLE "BookingEngineConfig" ADD COLUMN "immediateBookingExactTime" BOOLEAN NOT NULL DEFAULT false;
