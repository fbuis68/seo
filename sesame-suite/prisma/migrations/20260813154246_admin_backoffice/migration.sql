-- AlterTable
ALTER TABLE "EntityModuleConfig" ADD COLUMN     "darkH" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "hotelAddr" TEXT,
ADD COLUMN     "hotelEmail" TEXT,
ADD COLUMN     "kpi" JSONB,
ADD COLUMN     "logoIcon" TEXT,
ADD COLUMN     "msgWelcome" TEXT,
ADD COLUMN     "progName" TEXT DEFAULT 'Mon programme éco';

-- AlterTable
ALTER TABLE "HousekeepingStaff" ADD COLUMN     "assignedRoomCodes" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "HousekeepingTask" ADD COLUMN     "assignedStaffId" TEXT,
ADD COLUMN     "durationMinutes" INTEGER,
ADD COLUMN     "priority" TEXT NOT NULL DEFAULT 'normal',
ADD COLUMN     "subtype" TEXT;

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "templateKey" TEXT,
    "subject" TEXT,
    "content" TEXT,
    "audienceDesc" TEXT,
    "audienceSize" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_entityId_email_key" ON "AdminUser"("entityId", "email");

-- AddForeignKey
ALTER TABLE "AdminUser" ADD CONSTRAINT "AdminUser_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
