/*
  Warnings:

  - Added the required column `updatedAt` to the `Campaign` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "failureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "filterJson" JSONB,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "manualSelectionIds" JSONB,
ADD COLUMN     "name" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "scheduledAt" TIMESTAMP(3),
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "successCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "entityId" DROP NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'draft';

-- AlterTable
ALTER TABLE "ClientPrefs" ADD COLUMN     "emailOptOut" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "emailOptOutAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CrmProspect" ADD COLUMN     "emailOptOut" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "emailOptOutAt" TIMESTAMP(3);
