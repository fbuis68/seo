CREATE TABLE "ProspectingConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "territoire" TEXT NOT NULL DEFAULT 'France',
    "quotaHotel" INTEGER NOT NULL DEFAULT 30,
    "quotaPadel" INTEGER NOT NULL DEFAULT 12,
    "quotaResidence" INTEGER NOT NULL DEFAULT 8,
    "emergencyStopped" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProspectingConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "siren" TEXT,
    "companyName" TEXT,
    "motif" TEXT NOT NULL,
    "perimetre" TEXT NOT NULL DEFAULT 'total',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Suppression_email_idx" ON "Suppression"("email");
CREATE INDEX "Suppression_siren_idx" ON "Suppression"("siren");

CREATE TABLE "DiscoveryJob" (
    "id" TEXT NOT NULL,
    "marche" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "foundCount" INTEGER NOT NULL DEFAULT 0,
    "qualifiedCount" INTEGER NOT NULL DEFAULT 0,
    "excludedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveryJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DiscoveryJob_marche_idx" ON "DiscoveryJob"("marche");
CREATE INDEX "DiscoveryJob_createdAt_idx" ON "DiscoveryJob"("createdAt");
