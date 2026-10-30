ALTER TABLE "AdminUser" ADD COLUMN "bookingUrl" TEXT;
ALTER TABLE "CrmScoringConfig" ADD COLUMN "pointsQuoteTabViewed" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "CrmScoringConfig" ADD COLUMN "pointsQuoteDocumentOpened" INTEGER NOT NULL DEFAULT 3;
