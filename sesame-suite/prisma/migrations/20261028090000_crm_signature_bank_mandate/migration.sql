ALTER TABLE "CrmSignatureRequest" ADD COLUMN "requiresBankMandate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CrmSignatureRequest" ADD COLUMN "formData" JSONB;
ALTER TABLE "CrmSignatureRequest" ADD COLUMN "gocardlessCustomerId" TEXT;
ALTER TABLE "CrmSignatureRequest" ADD COLUMN "gocardlessMandateId" TEXT;
ALTER TABLE "CrmSignatureRequest" ADD COLUMN "mandateReference" TEXT;
