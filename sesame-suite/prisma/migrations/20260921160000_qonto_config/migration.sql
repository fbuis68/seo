-- CreateTable
CREATE TABLE "QontoConfig" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "login" TEXT NOT NULL,
    "secretKey" TEXT NOT NULL,
    "sandbox" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QontoConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QontoConfig_entityId_key" ON "QontoConfig"("entityId");

-- AddForeignKey
ALTER TABLE "QontoConfig" ADD CONSTRAINT "QontoConfig_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

