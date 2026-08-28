-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "bookingType" TEXT;

-- AlterTable
ALTER TABLE "BookingSourceConfig" ADD COLUMN     "updateBookingTypeParam" TEXT,
ADD COLUMN     "updateStatusValueMap" JSONB;
