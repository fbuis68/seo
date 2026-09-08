-- AlterTable
ALTER TABLE "BookingSourceConfig" ADD COLUMN     "nfcStopDeviceParam" TEXT DEFAULT 'id',
ADD COLUMN     "nfcStopEndpointMethod" TEXT DEFAULT 'GET',
ADD COLUMN     "nfcStopEndpointPath" TEXT;
