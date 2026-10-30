CREATE TABLE "CrmActivityChecklistItem" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmActivityChecklistItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CrmActivityChecklistItem_activityId_idx" ON "CrmActivityChecklistItem"("activityId");

ALTER TABLE "CrmActivityChecklistItem" ADD CONSTRAINT "CrmActivityChecklistItem_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "CrmActivity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
