-- AlterTable
ALTER TABLE "AccInvoice" ADD COLUMN     "amountPaid" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "AccBankMatch" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "bankTransactionId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "allocatedAmount" DOUBLE PRECISION NOT NULL,
    "score" DOUBLE PRECISION,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "AccBankMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccBankMatch_entityId_bankTransactionId_idx" ON "AccBankMatch"("entityId", "bankTransactionId");

-- CreateIndex
CREATE INDEX "AccBankMatch_entityId_invoiceId_idx" ON "AccBankMatch"("entityId", "invoiceId");

-- AddForeignKey
ALTER TABLE "AccBankMatch" ADD CONSTRAINT "AccBankMatch_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccBankMatch" ADD CONSTRAINT "AccBankMatch_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "AccBankTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccBankMatch" ADD CONSTRAINT "AccBankMatch_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "AccInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

