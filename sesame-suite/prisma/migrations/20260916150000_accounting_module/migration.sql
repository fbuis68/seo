-- CreateTable
CREATE TABLE "AccSupplier" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "name" TEXT NOT NULL,
    "siren" TEXT,
    "siret" TEXT,
    "vatNumber" TEXT,
    "addressLine" TEXT,
    "postalCode" TEXT,
    "city" TEXT,
    "country" TEXT DEFAULT 'FR',
    "email" TEXT,
    "phone" TEXT,
    "iban" TEXT,
    "bic" TEXT,
    "defaultAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccSupplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccCustomer" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "name" TEXT NOT NULL,
    "siren" TEXT,
    "siret" TEXT,
    "vatNumber" TEXT,
    "addressLine" TEXT,
    "postalCode" TEXT,
    "city" TEXT,
    "country" TEXT DEFAULT 'FR',
    "email" TEXT,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccDocument" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "sha256" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "contentBase64" TEXT NOT NULL,
    "storagePath" TEXT,
    "source" TEXT NOT NULL,
    "extractedText" TEXT,
    "extractionMethod" TEXT,
    "extractionConfidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccInvoice" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "documentId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "documentType" TEXT,
    "documentTypeConfidence" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "invoiceNumber" TEXT,
    "invoiceDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "serviceDate" TIMESTAMP(3),
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "currency" TEXT DEFAULT 'EUR',
    "language" TEXT,
    "orderNumber" TEXT,
    "contractRef" TEXT,
    "customerRef" TEXT,
    "supplierRef" TEXT,
    "paymentMethod" TEXT,
    "issuerName" TEXT,
    "issuerSiren" TEXT,
    "issuerSiret" TEXT,
    "issuerVat" TEXT,
    "issuerIban" TEXT,
    "issuerBic" TEXT,
    "recipientName" TEXT,
    "supplierId" TEXT,
    "supplierMatchConfidence" DOUBLE PRECISION,
    "customerId" TEXT,
    "amountHt" DOUBLE PRECISION,
    "amountDiscount" DOUBLE PRECISION,
    "amountFees" DOUBLE PRECISION,
    "amountShipping" DOUBLE PRECISION,
    "amountVat" DOUBLE PRECISION,
    "amountTtc" DOUBLE PRECISION,
    "amountDeposit" DOUBLE PRECISION,
    "amountDue" DOUBLE PRECISION,
    "proposedAccountId" TEXT,
    "proposedAccountConfidence" DOUBLE PRECISION,
    "entryId" TEXT,
    "fieldConfidence" JSONB,
    "globalConfidence" DOUBLE PRECISION,
    "checks" JSONB NOT NULL DEFAULT '[]',
    "validatedAt" TIMESTAMP(3),
    "validatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccInvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "reference" TEXT,
    "description" TEXT,
    "quantity" DOUBLE PRECISION,
    "unit" TEXT,
    "unitPrice" DOUBLE PRECISION,
    "discount" DOUBLE PRECISION,
    "amountHt" DOUBLE PRECISION,
    "vatRate" DOUBLE PRECISION,
    "vatAmount" DOUBLE PRECISION,
    "amountTtc" DOUBLE PRECISION,

    CONSTRAINT "AccInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccInvoiceVatLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "baseAmount" DOUBLE PRECISION NOT NULL,
    "vatAmount" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "AccInvoiceVatLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccAccount" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "number" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "class" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccJournal" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccJournal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccEntry" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "journalId" TEXT NOT NULL,
    "number" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "reversalOfEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validatedAt" TIMESTAMP(3),
    "validatedBy" TEXT,

    CONSTRAINT "AccEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccEntryLine" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "debit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "credit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "auxiliaryRef" TEXT,

    CONSTRAINT "AccEntryLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccRule" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "supplierId" TEXT,
    "keyword" TEXT,
    "accountId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccDuplicateCandidate" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "documentId" TEXT NOT NULL,
    "matchedDocumentId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAs" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccDuplicateCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccAuditLog" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "ip" TEXT,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccSupplier_entityId_siret_idx" ON "AccSupplier"("entityId", "siret");

-- CreateIndex
CREATE INDEX "AccSupplier_entityId_vatNumber_idx" ON "AccSupplier"("entityId", "vatNumber");

-- CreateIndex
CREATE INDEX "AccSupplier_entityId_iban_idx" ON "AccSupplier"("entityId", "iban");

-- CreateIndex
CREATE INDEX "AccCustomer_entityId_siret_idx" ON "AccCustomer"("entityId", "siret");

-- CreateIndex
CREATE INDEX "AccCustomer_entityId_vatNumber_idx" ON "AccCustomer"("entityId", "vatNumber");

-- CreateIndex
CREATE INDEX "AccDocument_entityId_sha256_idx" ON "AccDocument"("entityId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "AccInvoice_entryId_key" ON "AccInvoice"("entryId");

-- CreateIndex
CREATE INDEX "AccInvoice_entityId_status_idx" ON "AccInvoice"("entityId", "status");

-- CreateIndex
CREATE INDEX "AccInvoice_entityId_supplierId_idx" ON "AccInvoice"("entityId", "supplierId");

-- CreateIndex
CREATE INDEX "AccInvoice_entityId_invoiceNumber_idx" ON "AccInvoice"("entityId", "invoiceNumber");

-- CreateIndex
CREATE INDEX "AccAccount_entityId_number_idx" ON "AccAccount"("entityId", "number");

-- CreateIndex
CREATE INDEX "AccJournal_entityId_code_idx" ON "AccJournal"("entityId", "code");

-- CreateIndex
CREATE INDEX "AccEntry_entityId_journalId_status_idx" ON "AccEntry"("entityId", "journalId", "status");

-- CreateIndex
CREATE INDEX "AccRule_entityId_supplierId_idx" ON "AccRule"("entityId", "supplierId");

-- CreateIndex
CREATE INDEX "AccDuplicateCandidate_entityId_resolved_idx" ON "AccDuplicateCandidate"("entityId", "resolved");

-- CreateIndex
CREATE INDEX "AccAuditLog_entityId_targetType_targetId_idx" ON "AccAuditLog"("entityId", "targetType", "targetId");

-- AddForeignKey
ALTER TABLE "AccSupplier" ADD CONSTRAINT "AccSupplier_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccSupplier" ADD CONSTRAINT "AccSupplier_defaultAccountId_fkey" FOREIGN KEY ("defaultAccountId") REFERENCES "AccAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccCustomer" ADD CONSTRAINT "AccCustomer_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccDocument" ADD CONSTRAINT "AccDocument_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccInvoice" ADD CONSTRAINT "AccInvoice_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccInvoice" ADD CONSTRAINT "AccInvoice_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "AccDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccInvoice" ADD CONSTRAINT "AccInvoice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "AccSupplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccInvoice" ADD CONSTRAINT "AccInvoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "AccCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccInvoice" ADD CONSTRAINT "AccInvoice_proposedAccountId_fkey" FOREIGN KEY ("proposedAccountId") REFERENCES "AccAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccInvoice" ADD CONSTRAINT "AccInvoice_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "AccEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccInvoiceLine" ADD CONSTRAINT "AccInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "AccInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccInvoiceVatLine" ADD CONSTRAINT "AccInvoiceVatLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "AccInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccAccount" ADD CONSTRAINT "AccAccount_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccJournal" ADD CONSTRAINT "AccJournal_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccEntry" ADD CONSTRAINT "AccEntry_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccEntry" ADD CONSTRAINT "AccEntry_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "AccJournal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccEntry" ADD CONSTRAINT "AccEntry_reversalOfEntryId_fkey" FOREIGN KEY ("reversalOfEntryId") REFERENCES "AccEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccEntryLine" ADD CONSTRAINT "AccEntryLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "AccEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccEntryLine" ADD CONSTRAINT "AccEntryLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AccAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccRule" ADD CONSTRAINT "AccRule_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccRule" ADD CONSTRAINT "AccRule_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "AccSupplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccRule" ADD CONSTRAINT "AccRule_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AccAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccDuplicateCandidate" ADD CONSTRAINT "AccDuplicateCandidate_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccAuditLog" ADD CONSTRAINT "AccAuditLog_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

