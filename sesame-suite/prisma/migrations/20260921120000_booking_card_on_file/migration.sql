-- AlterTable
ALTER TABLE "PaymentConfig" ADD COLUMN     "publishableKey" TEXT;

-- AlterTable
ALTER TABLE "BookingEngineConfig" ADD COLUMN     "cardOnFileMode" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "stripeCustomerId" TEXT,
ADD COLUMN     "stripePaymentMethodId" TEXT;
