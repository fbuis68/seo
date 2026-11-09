CREATE TABLE "AutomationPendingSend" (
  "id" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "entityId" TEXT,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "templateKey" TEXT NOT NULL,
  "recipientTo" TEXT NOT NULL,
  "variables" JSONB NOT NULL,
  "senderName" TEXT,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AutomationPendingSend_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AutomationPendingSend_dueAt_idx" ON "AutomationPendingSend"("dueAt");
ALTER TABLE "AutomationPendingSend" ADD CONSTRAINT "AutomationPendingSend_ruleId_fkey"
  FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
