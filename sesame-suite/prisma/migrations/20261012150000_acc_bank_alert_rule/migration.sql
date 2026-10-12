-- CreateTable
CREATE TABLE "AccBankAlertRule" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "direction" TEXT,
    "bankAccountId" TEXT,
    "minAmount" DOUBLE PRECISION,
    "notifyEmail" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccBankAlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccBankAlertRule_entityId_active_idx" ON "AccBankAlertRule"("entityId", "active");

-- AddForeignKey
ALTER TABLE "AccBankAlertRule" ADD CONSTRAINT "AccBankAlertRule_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccBankAlertRule" ADD CONSTRAINT "AccBankAlertRule_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "AccBankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
