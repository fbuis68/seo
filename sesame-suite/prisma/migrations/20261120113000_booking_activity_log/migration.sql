-- CreateTable
CREATE TABLE "BookingActivityLog" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "actorLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingActivityLog_entityId_bookingId_createdAt_idx" ON "BookingActivityLog"("entityId", "bookingId", "createdAt");

-- AddForeignKey
ALTER TABLE "BookingActivityLog" ADD CONSTRAINT "BookingActivityLog_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingActivityLog" ADD CONSTRAINT "BookingActivityLog_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
