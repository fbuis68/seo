-- Bibliothèque de clauses du devis (22/10/2026) — remplace les 4 clauses
-- figées en dur côté client. Backfill des 4 clauses historiques pour ne
-- rien perdre côté devis déjà utilisant "+ Coffres conservés" etc.

CREATE TABLE "CrmQuoteClause" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmQuoteClause_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CrmQuoteClause_order_idx" ON "CrmQuoteClause"("order");

INSERT INTO "CrmQuoteClause" ("id","label","text","order","updatedAt") VALUES
  ('clause-coffre-seed', 'Coffres conservés', 'Les coffres mécaniques existants sont conservés, sous réserve de compatibilité et de bon état de fonctionnement lors de l''intervention.', 0, CURRENT_TIMESTAMP),
  ('clause-electric-seed', 'Électricité client', 'La fourniture et la pose des alimentations, câblages, prises et systèmes de verrouillage électrique sont à la charge du client ou de son électricien.', 1, CURRENT_TIMESTAMP),
  ('clause-gateway-seed', 'Réseau / gateways', 'L''implantation et le nombre de gateways seront confirmés après étude de couverture. Le réseau et les alimentations requis devront être opérationnels avant intervention.', 2, CURRENT_TIMESTAMP),
  ('clause-travel-seed', 'Déplacements', 'Les frais de déplacement, transport, hébergement et repas ne sont pas inclus, sauf forfait explicitement chiffré dans ce devis.', 3, CURRENT_TIMESTAMP);
