-- AlterTable
ALTER TABLE "BookingSourceConfig" ADD COLUMN     "webhookSecret" TEXT,
ADD COLUMN     "lastWebhookAt" TIMESTAMP(3),
ADD COLUMN     "lastWebhookEventCount" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "BookingSourceConfig_webhookSecret_key" ON "BookingSourceConfig"("webhookSecret");
