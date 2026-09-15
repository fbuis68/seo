-- CreateTable
CREATE TABLE "NumberSequence" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "NumberSequence_pkey" PRIMARY KEY ("key")
);

-- Backfill : initialise chaque compteur "ticket-YYYY"/"quote-YYYY" au plus
-- grand suffixe déjà utilisé parmi les numéros existants, pour que les
-- futurs numéros atomiques ne collisionnent jamais avec ceux créés avant
-- cette migration (cf. audit charge du 16/09/2026).
INSERT INTO "NumberSequence" ("key", "value")
SELECT 'ticket-' || substring(number from 5 for 4), MAX(substring(number from 10)::int)
FROM "CrmTicket"
WHERE number ~ '^TKT-\d{4}-\d+$'
GROUP BY substring(number from 5 for 4)
ON CONFLICT ("key") DO UPDATE SET "value" = GREATEST("NumberSequence"."value", EXCLUDED."value");

INSERT INTO "NumberSequence" ("key", "value")
SELECT 'quote-' || substring(number from 5 for 4), MAX(substring(number from 10)::int)
FROM "CrmQuote"
WHERE number ~ '^DEV-\d{4}-\d+$'
GROUP BY substring(number from 5 for 4)
ON CONFLICT ("key") DO UPDATE SET "value" = GREATEST("NumberSequence"."value", EXCLUDED."value");
