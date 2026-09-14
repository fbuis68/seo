-- Ajoute un identifiant lisible de ticket (TKT-<année>-<séquence>), même
-- convention que CrmQuote.number. Backfill des tickets déjà existants par
-- ordre de création, numérotés par année de création (cohérent avec
-- nextTicketNumber() qui compte les numéros déjà attribués pour l'année en
-- cours) avant de figer la colonne en NOT NULL + UNIQUE.
ALTER TABLE "CrmTicket" ADD COLUMN "number" TEXT;

WITH numbered AS (
  SELECT id,
         'TKT-' || EXTRACT(YEAR FROM "createdAt") || '-' || LPAD(
           ROW_NUMBER() OVER (PARTITION BY EXTRACT(YEAR FROM "createdAt") ORDER BY "createdAt")::text,
           4, '0'
         ) AS number
  FROM "CrmTicket"
)
UPDATE "CrmTicket" t SET "number" = n.number FROM numbered n WHERE t.id = n.id;

ALTER TABLE "CrmTicket" ALTER COLUMN "number" SET NOT NULL;
ALTER TABLE "CrmTicket" ADD CONSTRAINT "CrmTicket_number_key" UNIQUE ("number");
