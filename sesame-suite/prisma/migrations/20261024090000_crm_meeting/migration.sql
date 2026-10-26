-- Réunions Teams planifiées depuis une fiche prospect (24/10/2026, demande
-- client) — transcript/enregistrement/résumé récupérés a posteriori via
-- Microsoft Graph, voir src/lib/graphMeetings.ts et routes/crmMeeting.ts.

CREATE TABLE "CrmMeeting" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "organizerEmail" TEXT NOT NULL,
    "startDateTime" TIMESTAMP(3) NOT NULL,
    "endDateTime" TIMESTAMP(3) NOT NULL,
    "joinUrl" TEXT NOT NULL,
    "graphMeetingId" TEXT NOT NULL,
    "graphOrganizerUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "recordingGraphId" TEXT,
    "transcriptText" TEXT,
    "summaryText" TEXT,
    "actionItems" JSONB,
    "fetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmMeeting_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CrmMeeting_prospectId_idx" ON "CrmMeeting"("prospectId");

ALTER TABLE "CrmMeeting" ADD CONSTRAINT "CrmMeeting_prospectId_fkey"
  FOREIGN KEY ("prospectId") REFERENCES "CrmProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
