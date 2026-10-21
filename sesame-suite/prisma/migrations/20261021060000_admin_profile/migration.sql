-- CreateTable
-- Profils de droits personnalisés par établissement (panneau "Utilisateurs" > "Profils")
CREATE TABLE "AdminProfile" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "menuRights" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminProfile_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "profileId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AdminProfile_entityId_name_key" ON "AdminProfile"("entityId", "name");

-- CreateIndex
CREATE INDEX "AdminUser_profileId_idx" ON "AdminUser"("profileId");

-- AddForeignKey
ALTER TABLE "AdminProfile" ADD CONSTRAINT "AdminProfile_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminUser" ADD CONSTRAINT "AdminUser_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "AdminProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
