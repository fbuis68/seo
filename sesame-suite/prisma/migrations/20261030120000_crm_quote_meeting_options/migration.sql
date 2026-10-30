ALTER TABLE "CrmQuote" ADD COLUMN "attachedMeetingSummaryIds" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "CrmQuote" ADD COLUMN "attachedMeetingVideoIds" TEXT[] NOT NULL DEFAULT '{}';
