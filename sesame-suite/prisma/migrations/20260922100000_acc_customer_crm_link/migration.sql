-- AlterTable
ALTER TABLE "AccCustomer" ADD COLUMN     "crmProspectId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AccCustomer_crmProspectId_key" ON "AccCustomer"("crmProspectId");

-- AddForeignKey
ALTER TABLE "AccCustomer" ADD CONSTRAINT "AccCustomer_crmProspectId_fkey" FOREIGN KEY ("crmProspectId") REFERENCES "CrmProspect"("id") ON DELETE SET NULL ON UPDATE CASCADE;
