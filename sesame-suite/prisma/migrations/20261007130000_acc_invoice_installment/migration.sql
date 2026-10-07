-- CreateTable
-- Répartition du règlement d'une facture en tranches (ex : 65% à telle date, le solde à déterminer)
CREATE TABLE "AccInvoiceInstallment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "label" TEXT,
    "percentage" DOUBLE PRECISION,
    "amount" DOUBLE PRECISION NOT NULL,
    "dueDate" TIMESTAMP(3),
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccInvoiceInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccInvoiceInstallment_invoiceId_idx" ON "AccInvoiceInstallment"("invoiceId");

-- AddForeignKey
ALTER TABLE "AccInvoiceInstallment" ADD CONSTRAINT "AccInvoiceInstallment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "AccInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
