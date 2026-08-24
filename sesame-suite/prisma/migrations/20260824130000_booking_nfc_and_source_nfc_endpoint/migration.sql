ALTER TABLE "Booking" ADD COLUMN "nfcCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD COLUMN "nfcEncodedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "BookingSourceConfig" ADD COLUMN "nfcEndpointPath" TEXT;
ALTER TABLE "BookingSourceConfig" ADD COLUMN "nfcEndpointMethod" TEXT DEFAULT 'POST';
ALTER TABLE "BookingSourceConfig" ADD COLUMN "nfcEndpointBodyFormat" TEXT DEFAULT 'json';
ALTER TABLE "BookingSourceConfig" ADD COLUMN "nfcEndpointBodyParams" JSONB;
ALTER TABLE "BookingSourceConfig" ADD COLUMN "nfcCodeParam" TEXT DEFAULT 'code';
ALTER TABLE "BookingSourceConfig" ADD COLUMN "nfcResponseCountPath" TEXT;
