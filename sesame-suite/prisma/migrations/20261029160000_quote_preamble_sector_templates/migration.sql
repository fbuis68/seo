-- Modèles de devis par secteur (CrmQuoteTemplate)
ALTER TABLE "CrmQuoteTemplate" ADD COLUMN "secteur" TEXT;
ALTER TABLE "CrmQuoteTemplate" ADD COLUMN "introText" TEXT;
ALTER TABLE "CrmQuoteTemplate" ADD COLUMN "mentionsText" TEXT;

-- Pages d'intro du devis imprimable (deck pptx converti en images)
CREATE TABLE "CrmQuotePreamblePage" (
    "id" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "secteurs" TEXT[] NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmQuotePreamblePage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CrmQuotePreamblePage_order_idx" ON "CrmQuotePreamblePage"("order");
