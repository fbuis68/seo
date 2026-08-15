-- AlterTable
ALTER TABLE "AutomationRule" ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastErrorAt" TIMESTAMP(3);
