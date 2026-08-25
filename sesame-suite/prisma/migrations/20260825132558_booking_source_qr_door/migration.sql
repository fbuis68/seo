-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "doorLastOpenedAt" TIMESTAMP(3),
ADD COLUMN     "doorOpenCount" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "BookingSourceConfig" ADD COLUMN     "doorCodeParam" TEXT DEFAULT 'code',
ADD COLUMN     "doorEndpointBodyFormat" TEXT DEFAULT 'json',
ADD COLUMN     "doorEndpointBodyParams" JSONB,
ADD COLUMN     "doorEndpointMethod" TEXT DEFAULT 'POST',
ADD COLUMN     "doorEndpointPath" TEXT,
ADD COLUMN     "doorResponseSuccessPath" TEXT,
ADD COLUMN     "doorRoomParam" TEXT,
ADD COLUMN     "qrAccessCodePath" TEXT,
ADD COLUMN     "qrCodeParam" TEXT DEFAULT 'code',
ADD COLUMN     "qrEndpointBodyFormat" TEXT DEFAULT 'json',
ADD COLUMN     "qrEndpointBodyParams" JSONB,
ADD COLUMN     "qrEndpointMethod" TEXT DEFAULT 'GET',
ADD COLUMN     "qrEndpointPath" TEXT,
ADD COLUMN     "qrImagePath" TEXT,
ADD COLUMN     "qrValidUntilPath" TEXT,
ADD COLUMN     "qrValuePath" TEXT;
