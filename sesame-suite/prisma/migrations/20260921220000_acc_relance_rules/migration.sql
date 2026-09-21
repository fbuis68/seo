-- CreateTable
CREATE TABLE "AccRelanceRule" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "name" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "offsetDays" INTEGER NOT NULL,
    "direction" TEXT,
    "templateKey" TEXT NOT NULL,
    "attachInvoice" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccRelanceRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccRelanceSent" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccRelanceSent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccRelanceRule_entityId_active_idx" ON "AccRelanceRule"("entityId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "AccRelanceSent_ruleId_invoiceId_key" ON "AccRelanceSent"("ruleId", "invoiceId");

-- AddForeignKey
ALTER TABLE "AccRelanceRule" ADD CONSTRAINT "AccRelanceRule_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccRelanceSent" ADD CONSTRAINT "AccRelanceSent_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AccRelanceRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccRelanceSent" ADD CONSTRAINT "AccRelanceSent_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "AccInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

