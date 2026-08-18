-- Module "Gestion des affaires" : assignation d'un commercial (compte
-- role="sesame") à une fiche CRM, pipeline d'affaires (CrmDeal) et devis
-- (CrmQuote) rattachés à une affaire.

ALTER TABLE "CrmProspect" ADD COLUMN "commercialId" TEXT;
ALTER TABLE "CrmProspect" ADD CONSTRAINT "CrmProspect_commercialId_fkey"
  FOREIGN KEY ("commercialId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CrmDeal" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "commercialId" TEXT,
    "title" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'Nouveau',
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "probability" INTEGER NOT NULL DEFAULT 20,
    "closeDate" TIMESTAMP(3),
    "lostReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmDeal_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_prospectId_fkey"
  FOREIGN KEY ("prospectId") REFERENCES "CrmProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_commercialId_fkey"
  FOREIGN KEY ("commercialId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CrmQuote" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'brouillon',
    "lines" JSONB NOT NULL DEFAULT '[]',
    "discountPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmQuote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CrmQuote_number_key" ON "CrmQuote"("number");

ALTER TABLE "CrmQuote" ADD CONSTRAINT "CrmQuote_dealId_fkey"
  FOREIGN KEY ("dealId") REFERENCES "CrmDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
