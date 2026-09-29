-- CreateTable
CREATE TABLE "GuestSharingProfile" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "optIn" BOOLEAN NOT NULL DEFAULT false,
    "optInAt" TIMESTAMP(3),
    "photo" TEXT,
    "interests" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuestSharingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuestSharingProfile_bookingId_key" ON "GuestSharingProfile"("bookingId");

-- AddForeignKey
ALTER TABLE "GuestSharingProfile" ADD CONSTRAINT "GuestSharingProfile_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
