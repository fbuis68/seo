-- AlterTable
ALTER TABLE "AccBankAlertRule" ADD COLUMN "senderIdentityId" TEXT;

-- AddForeignKey
ALTER TABLE "AccBankAlertRule" ADD CONSTRAINT "AccBankAlertRule_senderIdentityId_fkey" FOREIGN KEY ("senderIdentityId") REFERENCES "EmailSenderIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
