import { prisma } from "../db";

/**
 * Compteur atomique — un seul INSERT ... ON CONFLICT ... RETURNING,
 * garanti sans collision par Postgres lui-même (verrouillage de ligne au
 * niveau SQL) même sous forte concurrence, contrairement au schéma
 * "compter les lignes existantes puis deviner le prochain numéro libre"
 * qu'il remplace (nextTicketNumber/nextQuoteNumber avant le 16/09/2026) —
 * confirmé racy par test de charge (centaines d'échecs "Unique constraint
 * failed" par lot de requêtes concurrentes sur la création de ticket,
 * endpoint public). `key` doit être stable et unique par compteur logique
 * (ex : "ticket-2026", "quote-2026").
 */
export async function nextSequenceValue(key: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ value: number }[]>`
    INSERT INTO "NumberSequence" ("key", "value") VALUES (${key}, 1)
    ON CONFLICT ("key") DO UPDATE SET "value" = "NumberSequence"."value" + 1
    RETURNING "value"
  `;
  return rows[0].value;
}
