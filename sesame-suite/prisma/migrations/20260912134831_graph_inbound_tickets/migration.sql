-- AlterTable
ALTER TABLE "CrmTicketMessage" ADD COLUMN     "graphMessageId" TEXT;

-- CreateTable
CREATE TABLE "GraphMailSubscription" (
    "id" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "clientState" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'inactive',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraphMailSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GraphMailSubscription_subscriptionId_key" ON "GraphMailSubscription"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmTicketMessage_graphMessageId_key" ON "CrmTicketMessage"("graphMessageId");
