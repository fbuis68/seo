-- Gestion des utilisateurs CRM + rôle (commercial notamment), catalogue
-- produits stockable/non-stockable, modèles de devis récurrents, et
-- signature électronique simple des devis (18/08/2026).

ALTER TABLE "AdminUser" ADD COLUMN "crmRole" TEXT NOT NULL DEFAULT 'commercial';
ALTER TABLE "AdminUser" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
-- Les comptes Sesame déjà existants ont déjà un accès complet en pratique
-- (créés manuellement/seed) : on les bascule en "admin" pour ne retirer
-- aucun accès à personne au moment de la migration.
UPDATE "AdminUser" SET "crmRole" = 'admin' WHERE "role" = 'sesame';

ALTER TABLE "CrmQuote" ADD COLUMN "signToken" TEXT;
CREATE UNIQUE INDEX "CrmQuote_signToken_key" ON "CrmQuote"("signToken");

CREATE TABLE "CrmQuoteSignature" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "signerName" TEXT NOT NULL,
    "signerEmail" TEXT,
    "signatureDataUrl" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmQuoteSignature_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CrmQuoteSignature_quoteId_key" ON "CrmQuoteSignature"("quoteId");
ALTER TABLE "CrmQuoteSignature" ADD CONSTRAINT "CrmQuoteSignature_quoteId_fkey"
  FOREIGN KEY ("quoteId") REFERENCES "CrmQuote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CrmProduct" (
    "id" TEXT NOT NULL,
    "sku" TEXT,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "unitPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "stockable" BOOLEAN NOT NULL DEFAULT false,
    "stockQty" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmProduct_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CrmQuoteTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmQuoteTemplate_pkey" PRIMARY KEY ("id")
);
