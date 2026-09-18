-- AlterTable
ALTER TABLE "AccSupplier" ADD COLUMN     "paymentTermDays" INTEGER,
ADD COLUMN     "paymentTermMode" TEXT;

-- CreateTable
CREATE TABLE "AccSettings" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "defaultPaymentTermDays" INTEGER NOT NULL DEFAULT 30,
    "defaultPaymentTermMode" TEXT NOT NULL DEFAULT 'net',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccSettings_entityId_key" ON "AccSettings"("entityId");

-- AddForeignKey
ALTER TABLE "AccSettings" ADD CONSTRAINT "AccSettings_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
