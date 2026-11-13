-- Réunions hors Teams (13/11/2026, demande client "pouvoir créer une
-- réunion autre que Teams et charger le transcript") — joinUrl/graphMeetingId/
-- graphOrganizerUserId ne sont renseignés que pour kind="teams".
ALTER TABLE "CrmMeeting" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'teams';
ALTER TABLE "CrmMeeting" ADD COLUMN "location" TEXT;
ALTER TABLE "CrmMeeting" ALTER COLUMN "joinUrl" DROP NOT NULL;
ALTER TABLE "CrmMeeting" ALTER COLUMN "graphMeetingId" DROP NOT NULL;
ALTER TABLE "CrmMeeting" ALTER COLUMN "graphOrganizerUserId" DROP NOT NULL;
