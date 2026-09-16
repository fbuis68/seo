-- CreateTable
CREATE TABLE "CrmContact" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fonction" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrmContact_prospectId_idx" ON "CrmContact"("prospectId");

-- AddForeignKey
ALTER TABLE "CrmContact" ADD CONSTRAINT "CrmContact_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "CrmProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
