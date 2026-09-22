-- AlterTable
ALTER TABLE "AccBankTransaction" ADD COLUMN     "qontoLabels" TEXT[] DEFAULT ARRAY[]::TEXT[];
