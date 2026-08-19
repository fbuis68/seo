-- CreateTable
CREATE TABLE "CrmCashLine" (
    "id" TEXT NOT NULL,
    "annee" INTEGER NOT NULL DEFAULT 2026,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "montant" DOUBLE PRECISION NOT NULL,
    "proba" INTEGER,
    "mois" INTEGER,
    "prospectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmCashLine_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CrmCashLine" ADD CONSTRAINT "CrmCashLine_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "CrmProspect"("id") ON DELETE SET NULL ON UPDATE CASCADE;
