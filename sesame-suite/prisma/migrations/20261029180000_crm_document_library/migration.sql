-- Remplace l'approche "pages pptx insérées dans le devis imprimable"
-- (CrmQuotePreamblePage, migration précédente) par une bibliothèque
-- documentaire autonome (CrmDocument), gérée à part et jointe au choix.
DROP TABLE IF EXISTS "CrmQuotePreamblePage";

CREATE TABLE "CrmDocument" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "fileName" TEXT NOT NULL,
    "fileMimeType" TEXT NOT NULL,
    "fileContentBase64" TEXT NOT NULL,
    "secteurs" TEXT[] NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CrmDocument_order_idx" ON "CrmDocument"("order");

ALTER TABLE "CrmQuote" ADD COLUMN "attachedDocumentIds" TEXT[] NOT NULL DEFAULT '{}';
