-- DropIndex
DROP INDEX "AdminUser_entityId_email_key";

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'hotel';

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "hotelName" TEXT NOT NULL,
    "stars" INTEGER NOT NULL DEFAULT 3,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "pmsLabel" TEXT,
    "modules" JSONB NOT NULL DEFAULT '[]',
    "basePrice" DOUBLE PRECISION NOT NULL,
    "modulePrices" JSONB NOT NULL DEFAULT '{}',
    "monthlyTotal" DOUBLE PRECISION NOT NULL,
    "paymentIbanHolder" TEXT,
    "paymentIbanLast4" TEXT,
    "status" TEXT NOT NULL DEFAULT 'trial',
    "trialDays" INTEGER NOT NULL DEFAULT 30,
    "trialEnd" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingConfig" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "basePrice" DOUBLE PRECISION NOT NULL DEFAULT 49,
    "trialDays" INTEGER NOT NULL DEFAULT 30,
    "modulePrices" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

