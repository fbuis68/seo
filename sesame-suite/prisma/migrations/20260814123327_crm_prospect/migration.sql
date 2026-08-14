-- CreateTable
CREATE TABLE "CrmProspect" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "subscriptionId" TEXT,
    "nom" TEXT NOT NULL,
    "groupe" TEXT,
    "secteur" TEXT,
    "ville" TEXT,
    "etoiles" TEXT,
    "danger" TEXT NOT NULL DEFAULT 'Modéré',
    "potentiel" INTEGER NOT NULL DEFAULT 0,
    "contrat" TEXT NOT NULL DEFAULT 'non',
    "modules" INTEGER NOT NULL DEFAULT 0,
    "pms" TEXT,
    "priorite" INTEGER NOT NULL DEFAULT 0,
    "appel" TEXT,
    "referent" TEXT,
    "email" TEXT,
    "tel" TEXT,
    "site" TEXT,
    "nfc" INTEGER NOT NULL DEFAULT 0,
    "qr" INTEGER NOT NULL DEFAULT 0,
    "mobile" INTEGER NOT NULL DEFAULT 0,
    "webApp" BOOLEAN NOT NULL DEFAULT false,
    "mobileV2" BOOLEAN NOT NULL DEFAULT false,
    "checkin" BOOLEAN NOT NULL DEFAULT false,
    "livret" BOOLEAN NOT NULL DEFAULT false,
    "gestionDemande" BOOLEAN NOT NULL DEFAULT false,
    "offline" BOOLEAN NOT NULL DEFAULT false,
    "messagerie" TEXT NOT NULL DEFAULT 'Noreply',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmProspect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmActivity" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "authorName" TEXT,
    "activityDate" TIMESTAMP(3),
    "done" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmProspect_subscriptionId_key" ON "CrmProspect"("subscriptionId");

-- AddForeignKey
ALTER TABLE "CrmProspect" ADD CONSTRAINT "CrmProspect_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmProspect" ADD CONSTRAINT "CrmProspect_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "CrmProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

