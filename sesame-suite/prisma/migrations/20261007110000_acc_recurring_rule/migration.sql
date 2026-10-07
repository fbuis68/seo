-- CreateTable
-- Récurrences bancaires qualifiées (module Trésorerie, phase 2, cahier §4.2 simplifié mensuel)
CREATE TABLE "AccRecurringRule" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "bankAccountId" TEXT,
    "sourceTransactionId" TEXT,
    "direction" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "counterpartyName" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "nextDate" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccRecurringRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccRecurringRule_entityId_active_idx" ON "AccRecurringRule"("entityId", "active");

-- AddForeignKey
ALTER TABLE "AccRecurringRule" ADD CONSTRAINT "AccRecurringRule_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccRecurringRule" ADD CONSTRAINT "AccRecurringRule_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "AccBankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
