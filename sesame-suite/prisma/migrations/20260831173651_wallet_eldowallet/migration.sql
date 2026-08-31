-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "walletCreatedAt" TIMESTAMP(3),
ADD COLUMN     "walletPassId" TEXT,
ADD COLUMN     "walletShortLink" TEXT,
ADD COLUMN     "walletStatus" TEXT;

-- CreateTable
CREATE TABLE "WalletConfig" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "hotelId" TEXT,
    "apiToken" TEXT,
    "lang" TEXT NOT NULL DEFAULT 'fr',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletConfig_entityId_key" ON "WalletConfig"("entityId");

-- AddForeignKey
ALTER TABLE "WalletConfig" ADD CONSTRAINT "WalletConfig_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
