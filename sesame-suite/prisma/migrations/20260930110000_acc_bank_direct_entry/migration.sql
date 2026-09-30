-- AlterTable
ALTER TABLE "AccBankTransaction" ADD COLUMN "entryId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AccBankTransaction_entryId_key" ON "AccBankTransaction"("entryId");

-- AddForeignKey
ALTER TABLE "AccBankTransaction" ADD CONSTRAINT "AccBankTransaction_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "AccEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
