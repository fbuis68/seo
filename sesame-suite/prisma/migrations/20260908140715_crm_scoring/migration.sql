-- Score d'intérêt CRM (08/09/2026) + lien cliquable optionnel par question
-- de questionnaire, cf. lib/crmScoring.ts, routes/crmScoring.ts.

-- AlterTable
ALTER TABLE "CrmProspect" ADD COLUMN     "hotLeadTaskCreatedAt" TIMESTAMP(3),
ADD COLUMN     "score" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "QuestionnaireQuestion" ADD COLUMN     "linkLabel" TEXT,
ADD COLUMN     "linkUrl" TEXT;

-- CreateTable
CREATE TABLE "CrmScoreEvent" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "module" TEXT,
    "source" TEXT NOT NULL DEFAULT 'internal',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmScoreEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmScoringConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "threshold" INTEGER NOT NULL DEFAULT 40,
    "pointsEmailOpened" INTEGER NOT NULL DEFAULT 1,
    "pointsModuleClick" INTEGER NOT NULL DEFAULT 5,
    "pointsModulePageVisit" INTEGER NOT NULL DEFAULT 5,
    "pointsRoiCalculator" INTEGER NOT NULL DEFAULT 10,
    "pointsTwoModulesViewed" INTEGER NOT NULL DEFAULT 5,
    "pointsDocRequest" INTEGER NOT NULL DEFAULT 10,
    "pointsDemoRequest" INTEGER NOT NULL DEFAULT 30,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmScoringConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrmScoreEvent_prospectId_idx" ON "CrmScoreEvent"("prospectId");

-- AddForeignKey
ALTER TABLE "CrmScoreEvent" ADD CONSTRAINT "CrmScoreEvent_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "CrmProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
