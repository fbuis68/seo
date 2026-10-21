-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "bookingTypeId" TEXT;

-- AlterTable
ALTER TABLE "BookingSourceConfig" ADD COLUMN     "updateBookingTypeIdParam" TEXT;

-- Backfill : les connecteurs "Sesame Technology" déjà configurés avant ce
-- correctif (updateBookingTypeParam="typeCode") n'ont pas ce nouveau champ
-- — sans ce backfill, le fix ne s'appliquerait qu'après réouverture/réenregistrement
-- manuel des réglages du connecteur côté admin.
UPDATE "BookingSourceConfig"
SET "updateBookingTypeIdParam" = 'typeId'
WHERE "presetId" = 'sesame' AND "updateBookingTypeIdParam" IS NULL;
