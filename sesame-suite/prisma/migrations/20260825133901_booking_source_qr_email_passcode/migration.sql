-- AlterTable
ALTER TABLE "BookingSourceConfig" ADD COLUMN     "doorEmailParam" TEXT,
ADD COLUMN     "qrEmailParam" TEXT,
ADD COLUMN     "qrPasscodeEndpointPath" TEXT,
ADD COLUMN     "qrPasscodeValuePath" TEXT;
