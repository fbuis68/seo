-- CreateTable
CREATE TABLE "ScalewayConfig" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "accessKey" TEXT NOT NULL,
    "secretKey" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScalewayConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScalewayConfig_entityId_key" ON "ScalewayConfig"("entityId");

-- AddForeignKey
ALTER TABLE "ScalewayConfig" ADD CONSTRAINT "ScalewayConfig_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
