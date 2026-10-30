ALTER TABLE "CrmProduct" ADD COLUMN "documentId" TEXT;
ALTER TABLE "CrmProduct" ADD CONSTRAINT "CrmProduct_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "CrmDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
