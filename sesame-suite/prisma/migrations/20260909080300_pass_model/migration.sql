-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "externalId" TEXT;

-- AlterTable
ALTER TABLE "BookingSourceConfig" ADD COLUMN     "passFieldMapping" JSONB,
ADD COLUMN     "passListBookingIdParam" TEXT DEFAULT 'bookingId',
ADD COLUMN     "passListEndpointBodyFormat" TEXT DEFAULT 'form',
ADD COLUMN     "passListEndpointMethod" TEXT DEFAULT 'GET',
ADD COLUMN     "passListEndpointPath" TEXT,
ADD COLUMN     "passListResponseListPath" TEXT DEFAULT 'root';

-- CreateTable
CREATE TABLE "Pass" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "personFirstname" TEXT NOT NULL,
    "personLastname" TEXT NOT NULL,
    "personEmail" TEXT,
    "master" BOOLEAN NOT NULL DEFAULT false,
    "facilityCode" TEXT,
    "facilityName" TEXT,
    "status" TEXT,
    "activated" BOOLEAN NOT NULL DEFAULT true,
    "nfcCount" INTEGER NOT NULL DEFAULT 0,
    "nfcEncodedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pass_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Pass_bookingId_externalId_key" ON "Pass"("bookingId", "externalId");

-- AddForeignKey
ALTER TABLE "Pass" ADD CONSTRAINT "Pass_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pass" ADD CONSTRAINT "Pass_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
