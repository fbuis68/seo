-- AlterTable
ALTER TABLE "BookingSourceConfig" ADD COLUMN     "nfcDeviceFilterField" TEXT,
ADD COLUMN     "nfcDeviceFilterValue" TEXT DEFAULT 'true';
