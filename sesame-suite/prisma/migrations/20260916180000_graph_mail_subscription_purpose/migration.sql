-- AlterTable
ALTER TABLE "GraphMailSubscription" ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'tickets';

-- CreateIndex
CREATE INDEX "GraphMailSubscription_purpose_idx" ON "GraphMailSubscription"("purpose");
