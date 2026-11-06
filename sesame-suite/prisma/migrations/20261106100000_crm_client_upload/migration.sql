CREATE TABLE "CrmClientUpload" (
  "id" TEXT NOT NULL,
  "prospectId" TEXT NOT NULL,
  "quoteId" TEXT,
  "fileName" TEXT NOT NULL,
  "fileMimeType" TEXT NOT NULL,
  "fileContentBase64" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmClientUpload_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CrmClientUpload_prospectId_idx" ON "CrmClientUpload"("prospectId");
CREATE INDEX "CrmClientUpload_quoteId_idx" ON "CrmClientUpload"("quoteId");

ALTER TABLE "CrmClientUpload" ADD CONSTRAINT "CrmClientUpload_prospectId_fkey"
  FOREIGN KEY ("prospectId") REFERENCES "CrmProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmClientUpload" ADD CONSTRAINT "CrmClientUpload_quoteId_fkey"
  FOREIGN KEY ("quoteId") REFERENCES "CrmQuote"("id") ON DELETE SET NULL ON UPDATE CASCADE;
