-- CrmProspect : extensions Sesame AI Sales Agent (Sprint 1)
ALTER TABLE "CrmProspect" ADD COLUMN "detectedProject" TEXT;
ALTER TABLE "CrmProspect" ADD COLUMN "detectedProjectDate" TIMESTAMP(3);
ALTER TABLE "CrmProspect" ADD COLUMN "enrichmentFields" JSONB;

-- CrmProduct : référentiel produit étendu
ALTER TABLE "CrmProduct" ADD COLUMN "targetSectors" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "CrmProduct" ADD COLUMN "benefits" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "CrmProduct" ADD COLUMN "useCases" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "CrmProduct" ADD COLUMN "integrations" TEXT[] NOT NULL DEFAULT '{}';

-- SalesSignal
CREATE TABLE "SalesSignal" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT,
    "companyName" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "hypothesis" TEXT,
    "status" TEXT NOT NULL DEFAULT 'to_verify',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesSignal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SalesSignal_prospectId_idx" ON "SalesSignal"("prospectId");
CREATE INDEX "SalesSignal_status_idx" ON "SalesSignal"("status");

ALTER TABLE "SalesSignal" ADD CONSTRAINT "SalesSignal_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "CrmProspect"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- SalesScore
CREATE TABLE "SalesScore" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "marketFit" INTEGER NOT NULL DEFAULT 0,
    "recentSignal" INTEGER NOT NULL DEFAULT 0,
    "economicPotential" INTEGER NOT NULL DEFAULT 0,
    "decisionMakerAccess" INTEGER NOT NULL DEFAULT 0,
    "urgency" INTEGER NOT NULL DEFAULT 0,
    "technicalFit" INTEGER NOT NULL DEFAULT 0,
    "dataReliability" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "classification" TEXT NOT NULL DEFAULT 'low_priority',
    "justification" JSONB,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesScore_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SalesScore_prospectId_idx" ON "SalesScore"("prospectId");

ALTER TABLE "SalesScore" ADD CONSTRAINT "SalesScore_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "CrmProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AgentDecisionLog
CREATE TABLE "AgentDecisionLog" (
    "id" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "prospectId" TEXT,
    "signalId" TEXT,
    "inputSummary" TEXT NOT NULL,
    "outputSummary" TEXT NOT NULL,
    "model" TEXT,
    "costUsd" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentDecisionLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentDecisionLog_agentName_idx" ON "AgentDecisionLog"("agentName");
CREATE INDEX "AgentDecisionLog_prospectId_idx" ON "AgentDecisionLog"("prospectId");
