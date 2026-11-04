-- Responsable de tâche (AdminUser) + id de l'événement Outlook synchronisé
ALTER TABLE "CrmActivity" ADD COLUMN "assigneeId" TEXT;
ALTER TABLE "CrmActivity" ADD COLUMN "outlookEventId" TEXT;

ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_assigneeId_fkey"
  FOREIGN KEY ("assigneeId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "CrmActivity_assigneeId_idx" ON "CrmActivity"("assigneeId");
