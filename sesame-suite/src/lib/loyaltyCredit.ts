import { Entity } from "@prisma/client";
import { prisma } from "../db";
import { resolveLoyaltyScope } from "./loyaltyScope";

/**
 * Point de convergence unique pour créditer/débiter un solde de fidélité —
 * utilisé par POST /wa/loyalty/credit (finalisation de séjour) et par
 * clientPrefs.ts (bonus d'inscription newsletter), pour ne pas dupliquer la
 * résolution de portée (par établissement ou par groupe, cf.
 * resolveLoyaltyScope) ni la création de la ligne d'historique.
 */
export async function creditLoyaltyPoints(
  entity: Entity,
  email: string,
  earned: number,
  spent: number,
  bookingCode?: string | null
): Promise<number> {
  const scope = await resolveLoyaltyScope(entity);
  const where = scope.groupId
    ? { groupId_email: { groupId: scope.groupId, email } }
    : { entityId_email: { entityId: scope.entityId as string, email } };

  const account = await prisma.loyaltyAccount.upsert({
    where,
    update: { totalPoints: { increment: earned - spent } },
    create: {
      entityId: scope.entityId,
      groupId: scope.groupId,
      email,
      totalPoints: Math.max(0, earned - spent),
    },
  });

  if (earned || spent) {
    await prisma.loyaltyTransaction.create({
      data: { accountId: account.id, earned, spent, bookingCode: bookingCode || null },
    });
  }

  return Math.max(0, account.totalPoints);
}
