-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "lockerNumbers" JSONB,
ADD COLUMN     "lockerPickupCode" TEXT,
ADD COLUMN     "lockerSourceOrderId" TEXT,
ADD COLUMN     "lockerSourceWarning" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "importedFrom" TEXT,
ADD COLUMN     "lockerLayout" JSONB,
ADD COLUMN     "stockQty" INTEGER,
ADD COLUMN     "vatRate" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "LockerSourceConfig" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "baseUrl" TEXT DEFAULT 'https://api.moncasierfrais.fr/v1',
    "apiToken" TEXT,
    "sellerGroupId" TEXT,
    "moduleId" TEXT,
    "defaultCategory" TEXT DEFAULT 'Mon Casier Frais',
    "syncIntervalMinutes" INTEGER,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncMessage" TEXT,
    "lastSyncCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LockerSourceConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LockerSourceConfig_entityId_key" ON "LockerSourceConfig"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_entityId_externalId_key" ON "Product"("entityId", "externalId");

-- AddForeignKey
ALTER TABLE "LockerSourceConfig" ADD CONSTRAINT "LockerSourceConfig_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

