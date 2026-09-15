-- CreateTable
CREATE TABLE "NayaxConfig" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "webhookSecret" TEXT,
    "terminalIdPath" TEXT DEFAULT 'terminalId',
    "sessionWindowSeconds" INTEGER NOT NULL DEFAULT 90,
    "lastWebhookAt" TIMESTAMP(3),
    "lastWebhookEventCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NayaxConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NayaxAccessSession" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "lastEventRaw" TEXT,

    CONSTRAINT "NayaxAccessSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NayaxConfig_entityId_key" ON "NayaxConfig"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "NayaxConfig_webhookSecret_key" ON "NayaxConfig"("webhookSecret");

-- CreateIndex
CREATE UNIQUE INDEX "NayaxAccessSession_token_key" ON "NayaxAccessSession"("token");

-- CreateIndex
CREATE INDEX "NayaxAccessSession_roomId_status_idx" ON "NayaxAccessSession"("roomId", "status");

-- AddForeignKey
ALTER TABLE "NayaxConfig" ADD CONSTRAINT "NayaxConfig_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NayaxAccessSession" ADD CONSTRAINT "NayaxAccessSession_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NayaxAccessSession" ADD CONSTRAINT "NayaxAccessSession_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
