-- AlterTable
ALTER TABLE "CrmSignatureRequest" ADD COLUMN     "prospectId" TEXT;

-- CreateIndex
CREATE INDEX "CrmSignatureRequest_prospectId_idx" ON "CrmSignatureRequest"("prospectId");

-- AddForeignKey
ALTER TABLE "CrmSignatureRequest" ADD CONSTRAINT "CrmSignatureRequest_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "CrmProspect"("id") ON DELETE SET NULL ON UPDATE CASCADE;
