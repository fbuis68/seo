-- AlterTable
ALTER TABLE "SmtpConfig" ADD COLUMN     "supportFromEmail" TEXT,
ADD COLUMN     "supportFromName" TEXT;

-- CreateTable
CREATE TABLE "CrmTicket" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "agentId" TEXT,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'En attente',
    "priority" TEXT NOT NULL DEFAULT 'Normale',
    "type" TEXT,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "contactEmail" TEXT NOT NULL,
    "contactName" TEXT,
    "publicToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "CrmTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmTicketMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "authorName" TEXT,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmTicketMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmTicket_publicToken_key" ON "CrmTicket"("publicToken");

-- AddForeignKey
ALTER TABLE "CrmTicket" ADD CONSTRAINT "CrmTicket_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "CrmProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmTicket" ADD CONSTRAINT "CrmTicket_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmTicketMessage" ADD CONSTRAINT "CrmTicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "CrmTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
