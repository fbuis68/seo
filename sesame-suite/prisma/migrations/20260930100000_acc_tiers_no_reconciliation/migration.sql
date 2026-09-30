-- AlterTable
ALTER TABLE "AccSupplier" ADD COLUMN "noReconciliationNeeded" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AccCustomer" ADD COLUMN "noReconciliationNeeded" BOOLEAN NOT NULL DEFAULT false;
