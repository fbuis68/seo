-- Certaines API (ex: /wa/booking/list de l'API Sesame Technology) exigent un
-- POST avec un corps application/x-www-form-urlencoded (typiquement de la
-- pagination : start/limit) au lieu d'un simple GET.
ALTER TABLE "BookingSourceConfig" ADD COLUMN "endpointMethod" TEXT DEFAULT 'GET',
ADD COLUMN "endpointBodyParams" JSONB,
ADD COLUMN "facilityEndpointMethod" TEXT DEFAULT 'GET',
ADD COLUMN "facilityEndpointBodyParams" JSONB;
