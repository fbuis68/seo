-- CreateTable
CREATE TABLE "AutologinCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "email" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutologinCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AutologinCode_code_key" ON "AutologinCode"("code");

-- CreateIndex
CREATE INDEX "AutologinCode_expiresAt_idx" ON "AutologinCode"("expiresAt");

-- AddForeignKey
ALTER TABLE "AutologinCode" ADD CONSTRAINT "AutologinCode_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
