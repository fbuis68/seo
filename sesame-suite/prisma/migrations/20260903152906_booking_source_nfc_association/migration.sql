-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "passId" TEXT;

-- AlterTable
ALTER TABLE "BookingSourceConfig" DROP COLUMN "nfcCodeParam",
DROP COLUMN "nfcEndpointBodyFormat",
DROP COLUMN "nfcEndpointBodyParams",
DROP COLUMN "nfcEndpointMethod",
DROP COLUMN "nfcEndpointPath",
DROP COLUMN "nfcResponseCountPath",
ADD COLUMN     "nfcCheckDeviceParam" TEXT DEFAULT 'id',
ADD COLUMN     "nfcCheckEndpointMethod" TEXT DEFAULT 'GET',
ADD COLUMN     "nfcCheckEndpointPath" TEXT,
ADD COLUMN     "nfcCheckMessagePath" TEXT DEFAULT 'message',
ADD COLUMN     "nfcCheckStopPath" TEXT DEFAULT 'stop',
ADD COLUMN     "nfcCheckSuccessPath" TEXT DEFAULT 'success',
ADD COLUMN     "nfcDeviceIdField" TEXT DEFAULT 'id',
ADD COLUMN     "nfcDeviceListBodyParams" JSONB,
ADD COLUMN     "nfcDeviceListEndpointMethod" TEXT DEFAULT 'GET',
ADD COLUMN     "nfcDeviceListEndpointPath" TEXT,
ADD COLUMN     "nfcDeviceListResponseListPath" TEXT,
ADD COLUMN     "nfcDeviceNameField" TEXT DEFAULT 'name',
ADD COLUMN     "nfcStartDeviceParam" TEXT DEFAULT 'deviceId',
ADD COLUMN     "nfcStartEndpointMethod" TEXT DEFAULT 'GET',
ADD COLUMN     "nfcStartEndpointPath" TEXT,
ADD COLUMN     "nfcStartExtraParams" JSONB,
ADD COLUMN     "nfcStartPassParam" TEXT DEFAULT 'id',
ADD COLUMN     "nfcStartTimeoutParam" TEXT DEFAULT 'timeout',
ADD COLUMN     "nfcStartTimeoutSeconds" INTEGER DEFAULT 15;

