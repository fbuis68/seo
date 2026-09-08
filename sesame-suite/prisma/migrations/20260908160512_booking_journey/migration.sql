-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "checkinStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TaxeSejourRecord" ADD COLUMN     "paid" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paidAt" TIMESTAMP(3);
