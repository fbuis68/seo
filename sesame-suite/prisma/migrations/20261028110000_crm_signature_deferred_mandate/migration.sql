ALTER TABLE "CrmSignatureRequest" ADD COLUMN "autoCreateMandate" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CrmSignatureRequest" ADD COLUMN "originalFileContentBase64" TEXT;
ALTER TABLE "CrmSignatureRequest" ADD COLUMN "pendingBankDataEncrypted" TEXT;
