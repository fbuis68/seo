-- CreateTable
CREATE TABLE "AccManualCashflow" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "direction" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccManualCashflow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccManualCashflow_entityId_paid_dueDate_idx" ON "AccManualCashflow"("entityId", "paid", "dueDate");

-- AddForeignKey
ALTER TABLE "AccManualCashflow" ADD CONSTRAINT "AccManualCashflow_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
