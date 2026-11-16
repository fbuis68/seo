-- Relance répétée d'une règle d'automatisation (16/11/2026, "renvoyer x
-- fois le message tous les y min/jour si le web check-in n'est pas passé").
ALTER TABLE "AutomationRule" ADD COLUMN "repeatEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AutomationRule" ADD COLUMN "repeatMaxCount" INTEGER;
ALTER TABLE "AutomationRule" ADD COLUMN "repeatIntervalValue" INTEGER;
ALTER TABLE "AutomationRule" ADD COLUMN "repeatIntervalUnit" TEXT;
ALTER TABLE "AutomationRule" ADD COLUMN "repeatStopCondition" TEXT;

ALTER TABLE "AutomationRuleLog" ADD COLUMN "count" INTEGER NOT NULL DEFAULT 1;
