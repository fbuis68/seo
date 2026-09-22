-- AlterTable
ALTER TABLE "AccCustomer" ADD COLUMN     "gocardlessCustomerId" TEXT;

-- CreateTable
CREATE TABLE "GoCardlessConfig" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "accessToken" TEXT NOT NULL,
    "sandbox" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoCardlessConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccGoCardlessPayout" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "gocardlessId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "arrivalDate" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "reference" TEXT,
    "bankTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccGoCardlessPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccGoCardlessPayment" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "gocardlessId" TEXT NOT NULL,
    "customerId" TEXT,
    "mandateId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "chargeDate" TIMESTAMP(3),
    "description" TEXT,
    "reference" TEXT,
    "payoutId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccGoCardlessPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoCardlessConfig_entityId_key" ON "GoCardlessConfig"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "AccGoCardlessPayout_gocardlessId_key" ON "AccGoCardlessPayout"("gocardlessId");

-- CreateIndex
CREATE UNIQUE INDEX "AccGoCardlessPayout_bankTransactionId_key" ON "AccGoCardlessPayout"("bankTransactionId");

-- CreateIndex
CREATE INDEX "AccGoCardlessPayout_entityId_status_idx" ON "AccGoCardlessPayout"("entityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AccGoCardlessPayment_gocardlessId_key" ON "AccGoCardlessPayment"("gocardlessId");

-- CreateIndex
CREATE INDEX "AccGoCardlessPayment_entityId_customerId_idx" ON "AccGoCardlessPayment"("entityId", "customerId");

-- CreateIndex
CREATE INDEX "AccGoCardlessPayment_entityId_status_idx" ON "AccGoCardlessPayment"("entityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AccCustomer_gocardlessCustomerId_key" ON "AccCustomer"("gocardlessCustomerId");

-- AddForeignKey
ALTER TABLE "GoCardlessConfig" ADD CONSTRAINT "GoCardlessConfig_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccGoCardlessPayout" ADD CONSTRAINT "AccGoCardlessPayout_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccGoCardlessPayout" ADD CONSTRAINT "AccGoCardlessPayout_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "AccBankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccGoCardlessPayment" ADD CONSTRAINT "AccGoCardlessPayment_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccGoCardlessPayment" ADD CONSTRAINT "AccGoCardlessPayment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "AccCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccGoCardlessPayment" ADD CONSTRAINT "AccGoCardlessPayment_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "AccGoCardlessPayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

