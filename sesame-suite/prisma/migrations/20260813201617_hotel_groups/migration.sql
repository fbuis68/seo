-- AlterTable
ALTER TABLE "Entity" ADD COLUMN     "groupId" TEXT;

-- AlterTable
ALTER TABLE "LoyaltyAccount" ADD COLUMN     "groupId" TEXT,
ALTER COLUMN "entityId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "loyaltyMode" TEXT NOT NULL DEFAULT 'independent',
    "ecoMode" TEXT NOT NULL DEFAULT 'independent',
    "sharedGains" JSONB,
    "sharedLoyaltyTiers" JSONB,
    "sharedEco" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Group_code_key" ON "Group"("code");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyAccount_groupId_email_key" ON "LoyaltyAccount"("groupId", "email");

-- AddForeignKey
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyAccount" ADD CONSTRAINT "LoyaltyAccount_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

