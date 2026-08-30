CREATE TABLE "PaymentConfig" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "secretKey" TEXT,
    "webhookSecret" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'eur',
    "allowInstallments" BOOLEAN NOT NULL DEFAULT false,
    "includeTaxeSejour" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentConfig_entityId_key" ON "PaymentConfig"("entityId");

ALTER TABLE "PaymentConfig" ADD CONSTRAINT "PaymentConfig_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Order" ADD COLUMN "paymentStatus" TEXT;
ALTER TABLE "Order" ADD COLUMN "stripeSessionId" TEXT;
ALTER TABLE "Order" ADD COLUMN "stripePaymentIntentId" TEXT;
ALTER TABLE "Order" ADD COLUMN "paidAt" TIMESTAMP(3);
