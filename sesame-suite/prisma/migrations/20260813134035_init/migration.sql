-- CreateTable
CREATE TABLE "Entity" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityModuleConfig" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "hotelName" TEXT NOT NULL,
    "hotelSlogan" TEXT,
    "stars" INTEGER NOT NULL DEFAULT 3,
    "colors" JSONB NOT NULL,
    "radius" INTEGER NOT NULL DEFAULT 14,
    "radiusBtn" INTEGER NOT NULL DEFAULT 8,
    "shadow" BOOLEAN NOT NULL DEFAULT true,
    "fontTitle" TEXT NOT NULL DEFAULT '''Fraunces'',serif',
    "fontBody" TEXT NOT NULL DEFAULT '''Sora'',sans-serif',
    "logoMain" TEXT,
    "msgEco" TEXT,
    "btnLabel" TEXT NOT NULL DEFAULT 'Continuer',
    "ptsLabel" TEXT NOT NULL DEFAULT 'Sesame Points',
    "lang" TEXT NOT NULL DEFAULT 'fr',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "tarifs" JSONB NOT NULL,
    "exoEnf" BOOLEAN NOT NULL DEFAULT true,
    "reducAdos" BOOLEAN NOT NULL DEFAULT true,
    "exoHand" BOOLEAN NOT NULL DEFAULT false,
    "eauMenage" INTEGER NOT NULL DEFAULT 15,
    "eauServ" INTEGER NOT NULL DEFAULT 40,
    "co2Factor" DOUBLE PRECISION NOT NULL DEFAULT 0.0003,
    "freqOpts" JSONB NOT NULL,
    "gains" JSONB NOT NULL,
    "checkinModules" JSONB NOT NULL,
    "rewardCatalog" JSONB,
    "loyaltyTiers" JSONB,
    "hotelPlan" TEXT,
    "roomTags" JSONB,
    "accessPoints" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntityModuleConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "floor" INTEGER NOT NULL DEFAULT 0,
    "surface" DOUBLE PRECISION,
    "category" TEXT,
    "tags" JSONB NOT NULL,
    "photos" JSONB NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "x" DOUBLE PRECISION,
    "y" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "personEmail" TEXT NOT NULL,
    "personFirstname" TEXT NOT NULL,
    "personLastname" TEXT NOT NULL,
    "personPhone" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "roomId" TEXT,
    "facilityCode" TEXT,
    "facilityName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "otaId" TEXT,
    "checkinDone" BOOLEAN NOT NULL DEFAULT false,
    "selectedRoomCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Occupant" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "ageCategory" TEXT NOT NULL,

    CONSTRAINT "Occupant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxeSejourRecord" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "bookingId" TEXT,
    "bookingCode" TEXT NOT NULL,
    "facilityCode" TEXT,
    "checkinDate" TIMESTAMP(3) NOT NULL,
    "checkoutDate" TIMESTAMP(3),
    "nights" INTEGER NOT NULL,
    "occupantsTotal" INTEGER NOT NULL,
    "occupantsAdultes" INTEGER NOT NULL,
    "occupantsAdos" INTEGER NOT NULL,
    "occupantsEnfants" INTEGER NOT NULL,
    "occupantsBebes" INTEGER NOT NULL,
    "tarifPerNightPerPerson" DOUBLE PRECISION NOT NULL,
    "montantBrut" DOUBLE PRECISION NOT NULL,
    "montantDeduction" DOUBLE PRECISION NOT NULL,
    "montantNet" DOUBLE PRECISION NOT NULL,
    "devise" TEXT NOT NULL DEFAULT 'EUR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxeSejourRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KycRecord" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "docType" TEXT,
    "fields" JSONB,
    "idVerified" BOOLEAN NOT NULL DEFAULT false,
    "selfieVerified" BOOLEAN NOT NULL DEFAULT false,
    "matchScore" INTEGER NOT NULL DEFAULT 0,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KycRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "price" DOUBLE PRECISION NOT NULL,
    "icon" TEXT,
    "photo" TEXT,
    "photos" JSONB,
    "videoUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "bookingId" TEXT,
    "bookingCode" TEXT,
    "source" TEXT NOT NULL,
    "clientName" TEXT,
    "roomCode" TEXT,
    "roomName" TEXT,
    "items" JSONB NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientPrefs" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "menageFreq" INTEGER,
    "servFreq" INTEGER,
    "menageNote" TEXT,
    "tags" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientPrefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyAccount" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "totalPoints" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LoyaltyAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyTransaction" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "earned" INTEGER NOT NULL DEFAULT 0,
    "spent" INTEGER NOT NULL DEFAULT 0,
    "bookingCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LivretSection" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "icon" TEXT,
    "content" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LivretSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomHousekeepingStatus" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'libre',
    "currentGuest" TEXT,
    "bookingCode" TEXT,
    "ecoPrefs" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomHousekeepingStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HousekeepingStaff" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "team" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HousekeepingStaff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HousekeepingTask" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "roomCode" TEXT NOT NULL,
    "taskDate" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'menage',
    "bookingCode" TEXT,
    "ecoAuto" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HousekeepingTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Entity_code_key" ON "Entity"("code");

-- CreateIndex
CREATE UNIQUE INDEX "EntityModuleConfig_entityId_key" ON "EntityModuleConfig"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Room_entityId_code_key" ON "Room"("entityId", "code");

-- CreateIndex
CREATE INDEX "Booking_personEmail_idx" ON "Booking"("personEmail");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_entityId_code_key" ON "Booking"("entityId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ClientPrefs_entityId_email_key" ON "ClientPrefs"("entityId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyAccount_entityId_email_key" ON "LoyaltyAccount"("entityId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "RoomHousekeepingStatus_roomId_key" ON "RoomHousekeepingStatus"("roomId");

-- AddForeignKey
ALTER TABLE "EntityModuleConfig" ADD CONSTRAINT "EntityModuleConfig_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Occupant" ADD CONSTRAINT "Occupant_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxeSejourRecord" ADD CONSTRAINT "TaxeSejourRecord_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxeSejourRecord" ADD CONSTRAINT "TaxeSejourRecord_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KycRecord" ADD CONSTRAINT "KycRecord_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientPrefs" ADD CONSTRAINT "ClientPrefs_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyAccount" ADD CONSTRAINT "LoyaltyAccount_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LoyaltyAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LivretSection" ADD CONSTRAINT "LivretSection_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomHousekeepingStatus" ADD CONSTRAINT "RoomHousekeepingStatus_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousekeepingStaff" ADD CONSTRAINT "HousekeepingStaff_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousekeepingTask" ADD CONSTRAINT "HousekeepingTask_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
