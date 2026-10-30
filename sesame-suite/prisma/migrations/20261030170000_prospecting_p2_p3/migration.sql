CREATE TABLE "OutreachConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "relanceDelaysDays" INTEGER[] DEFAULT ARRAY[4,10,20]::INTEGER[],
    "maxRelances" INTEGER NOT NULL DEFAULT 3,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OutreachDraft" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "contactId" TEXT,
    "signalId" TEXT,
    "sequenceStep" INTEGER NOT NULL DEFAULT 0,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_approval',
    "approvedById" TEXT,
    "approvedByName" TEXT,
    "approvedAt" TIMESTAMP(3),
    "recipientEmail" TEXT,
    "sentAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachDraft_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OutreachDraft_idempotencyKey_key" ON "OutreachDraft"("idempotencyKey");
CREATE INDEX "OutreachDraft_prospectId_idx" ON "OutreachDraft"("prospectId");
CREATE INDEX "OutreachDraft_status_idx" ON "OutreachDraft"("status");
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "CrmProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OutreachReply" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "draftId" TEXT,
    "fromEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "classification" TEXT NOT NULL DEFAULT 'to_classify',
    "extractedNeed" TEXT,
    "processedForMeeting" BOOLEAN NOT NULL DEFAULT false,
    "graphMessageId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachReply_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OutreachReply_graphMessageId_key" ON "OutreachReply"("graphMessageId");
CREATE INDEX "OutreachReply_prospectId_idx" ON "OutreachReply"("prospectId");
ALTER TABLE "OutreachReply" ADD CONSTRAINT "OutreachReply_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "CrmProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MeetingProposal" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "replyId" TEXT,
    "commercialId" TEXT,
    "commercialEmail" TEXT,
    "slot1" TIMESTAMP(3) NOT NULL,
    "slot2" TIMESTAMP(3) NOT NULL,
    "slot3" TIMESTAMP(3) NOT NULL,
    "briefText" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_approval',
    "confirmedSlot" TIMESTAMP(3),
    "meetingId" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingProposal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MeetingProposal_prospectId_idx" ON "MeetingProposal"("prospectId");
CREATE INDEX "MeetingProposal_status_idx" ON "MeetingProposal"("status");
ALTER TABLE "MeetingProposal" ADD CONSTRAINT "MeetingProposal_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "CrmProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
