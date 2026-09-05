-- AlterTable
ALTER TABLE "CrmProspect" ADD COLUMN     "origine" TEXT;

-- CreateTable
CREATE TABLE "CrmSectorOption" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmSectorOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmSectorOption_label_key" ON "CrmSectorOption"("label");


-- Reprend la liste SECTEURS jusque-là codée en dur dans public/crm.html,
-- pour que la bascule vers CrmSectorOption (liste éditable en base) ne
-- fasse disparaître aucune option existante du menu déroulant.
INSERT INTO "CrmSectorOption" ("id", "label", "order") VALUES
  (gen_random_uuid()::text, 'Hôtellerie', 0),
  (gen_random_uuid()::text, 'Location appartement', 1),
  (gen_random_uuid()::text, 'Appart Hotel', 2),
  (gen_random_uuid()::text, 'Location AirBnB', 3),
  (gen_random_uuid()::text, 'Bureaux', 4),
  (gen_random_uuid()::text, 'Sport', 5),
  (gen_random_uuid()::text, 'Garde meuble', 6),
  (gen_random_uuid()::text, 'Love hôtel', 7),
  (gen_random_uuid()::text, 'Location bureau', 8),
  (gen_random_uuid()::text, 'Agence gestion patrimoine', 9)
ON CONFLICT ("label") DO NOTHING;
