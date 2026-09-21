-- AlterTable
ALTER TABLE "AccInvoice" ADD COLUMN     "customerMatchConfidence" DOUBLE PRECISION,
ADD COLUMN     "recipientSiren" TEXT,
ADD COLUMN     "recipientSiret" TEXT,
ADD COLUMN     "recipientVat" TEXT;

