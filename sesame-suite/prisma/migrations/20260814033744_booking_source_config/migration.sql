-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "importedFrom" TEXT;

-- CreateTable
CREATE TABLE "BookingSourceConfig" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "sourceName" TEXT,
    "baseUrl" TEXT,
    "endpointPath" TEXT,
    "authType" TEXT NOT NULL DEFAULT 'none',
    "authApiKeyHeader" TEXT,
    "authApiKeyValue" TEXT,
    "authBearerToken" TEXT,
    "authBasicUser" TEXT,
    "authBasicPassword" TEXT,
    "responseListPath" TEXT,
    "fieldMapping" JSONB,
    "syncIntervalMinutes" INTEGER,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncMessage" TEXT,
    "lastSyncCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingSourceConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingSourceConfig_entityId_key" ON "BookingSourceConfig"("entityId");

-- AddForeignKey
ALTER TABLE "BookingSourceConfig" ADD CONSTRAINT "BookingSourceConfig_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

