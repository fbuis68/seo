-- AlterTable
ALTER TABLE "ClientPrefs" ADD COLUMN     "newsletterOptIn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "newsletterOptInAt" TIMESTAMP(3),
ADD COLUMN     "newsletterPointsAwarded" BOOLEAN NOT NULL DEFAULT false;

