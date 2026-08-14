-- AlterTable
ALTER TABLE "BookingSourceConfig" ADD COLUMN     "facilityEndpointPath" TEXT,
ADD COLUMN     "facilityFieldMapping" JSONB,
ADD COLUMN     "facilityResponseListPath" TEXT;

