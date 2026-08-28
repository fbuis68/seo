-- AlterTable
ALTER TABLE "BookingSourceConfig" ADD COLUMN     "updateCodeParam" TEXT DEFAULT 'code',
ADD COLUMN     "updateEndpointBodyFormat" TEXT DEFAULT 'json',
ADD COLUMN     "updateEndpointBodyParams" JSONB,
ADD COLUMN     "updateEndpointMethod" TEXT DEFAULT 'POST',
ADD COLUMN     "updateEndpointPath" TEXT,
ADD COLUMN     "updateRoomParam" TEXT,
ADD COLUMN     "updateStatusParam" TEXT;
