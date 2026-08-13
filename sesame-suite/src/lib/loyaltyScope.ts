import { Entity } from "@prisma/client";
import { prisma } from "../db";

/**
 * Résout la portée du solde de fidélité pour un établissement : scope par
 * groupe (points cumulés sur tous les hôtels du groupe) si l'établissement
 * appartient à un Group avec loyaltyMode="centralized", sinon scope par
 * établissement (comportement historique, un solde par hôtel).
 */
export async function resolveLoyaltyScope(entity: Entity): Promise<{ entityId: string | null; groupId: string | null }> {
  if (entity.groupId) {
    const group = await prisma.group.findUnique({ where: { id: entity.groupId } });
    if (group?.loyaltyMode === "centralized") {
      return { entityId: null, groupId: group.id };
    }
  }
  return { entityId: entity.id, groupId: null };
}
