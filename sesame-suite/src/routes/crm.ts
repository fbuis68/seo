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
 * Pas de table CRM dédiée — cohérent avec le fait que ce sont les mêmes
 * données déjà exposées côté client, simplement recomposées ici.
 */
crmRouter.get(
  "/crm/clients",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const [bookings, loyaltyAccounts, prefs, cfg] = await Promise.all([
      prisma.booking.findMany({ where: { entityId: entity.id }, orderBy: { startDate: "desc" } }),
      prisma.loyaltyAccount.findMany({ where: { entityId: entity.id } }),
      prisma.clientPrefs.findMany({ where: { entityId: entity.id } }),
      prisma.entityModuleConfig.findUnique({ where: { entityId: entity.id } }),
    ]);

    const pointsByEmail = new Map(loyaltyAccounts.map((a) => [a.email, a.totalPoints]));
    const prefsByEmail = new Map(prefs.map((p) => [p.email, p]));
    const tiers = (cfg?.loyaltyTiers as unknown as LoyaltyTiers | null) || null;

    const byEmail = new Map<
      string,
      { email: string; firstname: string; lastname: string; phone: string; stays: number; lastStay: string }
    >();
    for (const b of bookings) {
      const key = b.personEmail.toLowerCase();
      const existing = byEmail.get(key);
      if (existing) {
        existing.stays += 1;
        if (b.startDate.toISOString() > existing.lastStay) existing.lastStay = b.startDate.toISOString();
      } else {
        byEmail.set(key, {
          email: b.personEmail,
          firstname: b.personFirstname,
          lastname: b.personLastname,
          phone: b.personPhone || "",
          stays: 1,
          lastStay: b.startDate.toISOString(),
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
      };
    });

    clients.sort((a, b) => b.points - a.points);
    res.json(clients);
  })
);
