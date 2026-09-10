-- Ouverture directe d'un accès sans réservation (cf. openFacilityDirect,
-- GET /wa/allFacility/open côté Sesame — confirmé le 10/09/2026).
ALTER TABLE "Room" ADD COLUMN "externalFacilityId" TEXT;

ALTER TABLE "BookingSourceConfig" ADD COLUMN "facilityOpenEndpointPath" TEXT;
ALTER TABLE "BookingSourceConfig" ADD COLUMN "facilityOpenEndpointMethod" TEXT DEFAULT 'GET';
ALTER TABLE "BookingSourceConfig" ADD COLUMN "facilityOpenIdParam" TEXT DEFAULT 'id';
ALTER TABLE "BookingSourceConfig" ADD COLUMN "facilityOpenResponseSuccessPath" TEXT;
ALTER TABLE "BookingSourceConfig" ADD COLUMN "facilityOpenResponseMessagePath" TEXT;
