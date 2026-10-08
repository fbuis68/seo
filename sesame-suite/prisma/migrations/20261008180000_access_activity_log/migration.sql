-- CreateTable
-- Traçabilité des ouvertures d'accès (panneau "Gestion des Accès")
CREATE TABLE "AccessActivityLog" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "bookingCode" TEXT,
    "guestName" TEXT,
    "roomCode" TEXT,
    "actorType" TEXT NOT NULL,
    "actorLabel" TEXT,
    "success" BOOLEAN NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccessActivityLog_entityId_createdAt_idx" ON "AccessActivityLog"("entityId", "createdAt");

-- AddForeignKey
ALTER TABLE "AccessActivityLog" ADD CONSTRAINT "AccessActivityLog_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
