-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "icon" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'partner',
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ProductVendor" (
    "productId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,

    CONSTRAINT "ProductVendor_pkey" PRIMARY KEY ("productId","vendorId")
);

-- CreateIndex
CREATE INDEX "ProductVendor_vendorId_idx" ON "ProductVendor"("vendorId");

-- AddForeignKey
ALTER TABLE "ProductVendor" ADD CONSTRAINT "ProductVendor_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVendor" ADD CONSTRAINT "ProductVendor_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DataMigration : "tout produit doit être rattaché à au moins un point de
-- vente" devient une règle applicative à partir de cette version — les
-- produits existants (créés avant que Vendor/ProductVendor n'existent) n'ont
-- aucun rattachement. On crée donc un point de vente interne par défaut
-- ("Boutique principale") pour CHAQUE établissement, puis on y rattache tous
-- ses produits qui n'ont pas déjà un Vendor gérant (vendorId IS NULL =
-- catalogue propre de l'hôtel). Les produits déjà gérés par un partenaire
-- (vendorId renseigné, cf. migration vendor_marketplace précédente) sont
-- rattachés à ce même Vendor via la table de liaison, pour rester cohérents
-- avec le nouveau modèle "où ce produit est en vente" — un seul point de
-- vente pour eux, celui de leur partenaire gérant.

INSERT INTO "Vendor" (id, "entityId", name, kind, status, "commissionPct", "portalToken", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "Entity".id, 'Boutique principale', 'internal', 'active', 0, gen_random_uuid()::text, now(), now()
FROM "Entity";

INSERT INTO "ProductVendor" ("productId", "vendorId")
SELECT "Product".id, "Vendor".id
FROM "Product"
JOIN "Vendor" ON "Vendor"."entityId" = "Product"."entityId" AND "Vendor".name = 'Boutique principale' AND "Vendor".kind = 'internal'
WHERE "Product"."vendorId" IS NULL;

INSERT INTO "ProductVendor" ("productId", "vendorId")
SELECT id, "vendorId" FROM "Product" WHERE "vendorId" IS NOT NULL;

