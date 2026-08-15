-- AlterTable
ALTER TABLE "AutomationRule" ADD COLUMN     "recipientMode" TEXT NOT NULL DEFAULT 'event',
ADD COLUMN     "recipientOverride" TEXT,
ADD COLUMN     "senderName" TEXT;
