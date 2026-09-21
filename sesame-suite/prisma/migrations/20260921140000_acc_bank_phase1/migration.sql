-- CreateTable
CREATE TABLE "AccBankAccount" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "bank" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "iban" TEXT,
    "bic" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "type" TEXT,
    "accountId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'csv',
    "providerAccountId" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "availableBalance" DOUBLE PRECISION,
    "accountingBalance" DOUBLE PRECISION,
    "connectionStatus" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccBankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccBankTransaction" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "bankAccountId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "operationDate" TIMESTAMP(3) NOT NULL,
    "valueDate" TIMESTAMP(3),
    "amount" DOUBLE PRECISION NOT NULL,
    "direction" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "rawLabel" TEXT NOT NULL,
    "normalizedLabel" TEXT,
    "counterpartyName" TEXT,
    "counterpartyIban" TEXT,
    "counterpartyBic" TEXT,
    "transactionRef" TEXT,
    "endToEndId" TEXT,
    "sepaMandateRef" TEXT,
    "creditorRef" TEXT,
    "paymentType" TEXT,
    "bankCategory" TEXT,
    "classification" TEXT,
    "classificationConfidence" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'IMPORTED',
    "source" TEXT NOT NULL,
    "rawData" JSONB NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccBankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccBankAccount_entityId_idx" ON "AccBankAccount"("entityId");

-- CreateIndex
CREATE INDEX "AccBankTransaction_entityId_status_idx" ON "AccBankTransaction"("entityId", "status");

-- CreateIndex
CREATE INDEX "AccBankTransaction_entityId_bankAccountId_operationDate_idx" ON "AccBankTransaction"("entityId", "bankAccountId", "operationDate");

-- CreateIndex
CREATE UNIQUE INDEX "AccBankTransaction_bankAccountId_externalId_key" ON "AccBankTransaction"("bankAccountId", "externalId");

-- AddForeignKey
ALTER TABLE "AccBankAccount" ADD CONSTRAINT "AccBankAccount_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccBankAccount" ADD CONSTRAINT "AccBankAccount_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AccAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccBankTransaction" ADD CONSTRAINT "AccBankTransaction_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccBankTransaction" ADD CONSTRAINT "AccBankTransaction_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "AccBankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

