-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "bookingTypeId" TEXT;

-- AlterTable
ALTER TABLE "BookingSourceConfig" ADD COLUMN     "updateBookingTypeIdParam" TEXT;
