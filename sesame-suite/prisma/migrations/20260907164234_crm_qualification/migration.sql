-- AlterTable
ALTER TABLE "CrmProspect" ADD COLUMN     "qualificationSentAt" TIMESTAMP(3),
ADD COLUMN     "qualificationToken" TEXT;

-- CreateTable
CREATE TABLE "CrmQualificationResponse" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "interested" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmQualificationResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrmQualificationResponse_prospectId_idx" ON "CrmQualificationResponse"("prospectId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmQualificationResponse_prospectId_moduleKey_key" ON "CrmQualificationResponse"("prospectId", "moduleKey");

-- CreateIndex
CREATE UNIQUE INDEX "CrmProspect_qualificationToken_key" ON "CrmProspect"("qualificationToken");

-- AddForeignKey
ALTER TABLE "CrmQualificationResponse" ADD CONSTRAINT "CrmQualificationResponse_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "CrmProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

