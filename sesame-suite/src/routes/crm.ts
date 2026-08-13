import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";

export const crmRouter = Router();

interface LoyaltyTiers {
  gold: number;
  premium: number;
}

function computeTier(points: number, tiers: LoyaltyTiers | null) {
  const gold = tiers?.gold ?? 500;
  const premium = tiers?.premium ?? 1500;
  if (points >= premium) return "Premium";
  if (points >= gold) return "Gold";
  return "Standard";
}

/**
 * GET /wa/crm/clients — fiches clients agrégées (panneau "Base clients") :
 * réservations (Booking), fidélité (LoyaltyAccount), préférences (ClientPrefs).
 *
 * Si l'établissement appartient à un groupe à fidélité centralisée, les
 * réservations et préférences sont agrégées sur TOUS les hôtels du groupe
 * (base clients partagée, cf. panneau "Groupes") — jamais au-delà des
 * frontières du groupe.
 */
crmRouter.get(
  "/crm/clients",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const group = entity.groupId ? await prisma.group.findUnique({ where: { id: entity.groupId } }) : null;
    const groupAggregated = group?.loyaltyMode === "centralized";

    const entityIds = groupAggregated
      ? (await prisma.entity.findMany({ where: { groupId: group!.id }, select: { id: true } })).map((e) => e.id)
      : [entity.id];
    const hotelsById = groupAggregated
      ? new Map((await prisma.entity.findMany({ where: { id: { in: entityIds } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]))
      : new Map([[entity.id, entity.name]]);

    const [bookings, loyaltyAccounts, prefs, cfg] = await Promise.all([
      prisma.booking.findMany({ where: { entityId: { in: entityIds } }, orderBy: { startDate: "desc" } }),
      groupAggregated
        ? prisma.loyaltyAccount.findMany({ where: { groupId: group!.id } })
        : prisma.loyaltyAccount.findMany({ where: { entityId: entity.id } }),
      prisma.clientPrefs.findMany({ where: { entityId: { in: entityIds } } }),
      prisma.entityModuleConfig.findUnique({ where: { entityId: entity.id } }),
    ]);

    const pointsByEmail = new Map(loyaltyAccounts.map((a) => [a.email, a.totalPoints]));
    const prefsByEmail = new Map(prefs.map((p) => [p.email, p]));
    const tiers = (cfg?.loyaltyTiers as unknown as LoyaltyTiers | null) || null;

    const byEmail = new Map<
      string,
      { email: string; firstname: string; lastname: string; phone: string; stays: number; lastStay: string; hotels: Set<string> }
    >();
    for (const b of bookings) {
      const key = b.personEmail.toLowerCase();
      const existing = byEmail.get(key);
      const hotelName = hotelsById.get(b.entityId) || "";
      if (existing) {
        existing.stays += 1;
        if (hotelName) existing.hotels.add(hotelName);
        if (b.startDate.toISOString() > existing.lastStay) existing.lastStay = b.startDate.toISOString();
      } else {
        byEmail.set(key, {
          email: b.personEmail,
          firstname: b.personFirstname,
          lastname: b.personLastname,
          phone: b.personPhone || "",
          stays: 1,
          lastStay: b.startDate.toISOString(),
          hotels: new Set(hotelName ? [hotelName] : []),
        });
      }
    }

    const clients = Array.from(byEmail.values()).map((c) => {
      const points = pointsByEmail.get(c.email.toLowerCase()) || 0;
      const pref = prefsByEmail.get(c.email.toLowerCase());
      return {
        email: c.email,
        firstname: c.firstname,
        lastname: c.lastname,
        phone: c.phone,
        stays: c.stays,
        lastStay: c.lastStay.slice(0, 10),
        points,
        tier: computeTier(points, tiers),
        tags: (pref?.tags as string[]) || [],
        hotels: groupAggregated ? Array.from(c.hotels) : undefined,
      };
    });

    clients.sort((a, b) => b.points - a.points);
    res.json({
      clients,
      groupAggregated,
      groupName: groupAggregated ? group!.name : null,
    });
  })
);
