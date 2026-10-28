-- Agent Market Intelligence : date du dernier scan d'actualité par prospect
ALTER TABLE "CrmProspect" ADD COLUMN "lastSignalScanAt" TIMESTAMP(3);
