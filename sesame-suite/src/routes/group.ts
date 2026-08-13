import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";

export const groupRouter = Router();

async function nextGroupCode(): Promise<string> {
  const count = await prisma.group.count();
  return "G" + String(count + 1).padStart(6, "0");
}

function shapeGroup(g: {
  id: string;
  code: string;
  name: string;
  loyaltyMode: string;
  ecoMode: string;
  sharedGains: unknown;
  sharedLoyaltyTiers: unknown;
  sharedEco: unknown;
  createdAt: Date;
  entities?: { code: string; name: string }[];
}) {
  return {
    code: g.code,
    name: g.name,
    loyaltyMode: g.loyaltyMode,
    ecoMode: g.ecoMode,
    sharedGains: g.sharedGains || null,
    sharedLoyaltyTiers: g.sharedLoyaltyTiers || null,
    sharedEco: g.sharedEco || null,
    createdAt: g.createdAt,
    hotels: (g.entities || []).map((e) => ({ code: e.code, name: e.name })),
  };
}

/** GET /wa/group/list — groupes + établissements membres (Sesame uniquement). */
groupRouter.get(
  "/group/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const groups = await prisma.group.findMany({
      include: { entities: { select: { code: true, name: true } } },
      orderBy: { createdAt: "asc" },
    });
    res.json(groups.map(shapeGroup));
  })
);

interface CreateGroupBody {
  name: string;
  loyaltyMode?: "centralized" | "independent";
  ecoMode?: "centralized" | "independent";
}

/** POST /wa/group/create */
groupRouter.post(
  "/group/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as CreateGroupBody;
    if (!b.name) throw new HttpError(400, "Nom du groupe requis");
    const code = await nextGroupCode();
    const group = await prisma.group.create({
      data: {
        code,
        name: b.name,
        loyaltyMode: b.loyaltyMode === "centralized" ? "centralized" : "independent",
        ecoMode: b.ecoMode === "centralized" ? "centralized" : "independent",
      },
    });
    res.status(201).json(shapeGroup({ ...group, entities: [] }));
  })
);

interface UpdateGroupBody {
  code: string;
  name?: string;
  loyaltyMode?: "centralized" | "independent";
  ecoMode?: "centralized" | "independent";
  sharedGains?: unknown;
  sharedLoyaltyTiers?: unknown;
  sharedEco?: unknown;
}

/** POST /wa/group/update — réglages du groupe + politique partagée (gains/éco). */
groupRouter.post(
  "/group/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as UpdateGroupBody;
    if (!b.code) throw new HttpError(400, "code requis");
    const group = await prisma.group.findUnique({ where: { code: b.code } });
    if (!group) throw new HttpError(404, "Groupe introuvable");

    const updated = await prisma.group.update({
      where: { id: group.id },
      data: {
        name: b.name,
        loyaltyMode: b.loyaltyMode,
        ecoMode: b.ecoMode,
        sharedGains: b.sharedGains as never,
        sharedLoyaltyTiers: b.sharedLoyaltyTiers as never,
        sharedEco: b.sharedEco as never,
      },
      include: { entities: { select: { code: true, name: true } } },
    });
    res.json(shapeGroup(updated));
  })
);

/** POST /wa/group/delete — body: { code } — détache les hôtels (ne les supprime pas). */
groupRouter.post(
  "/group/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const code = (req.body.code as string) || "";
    const group = await prisma.group.findUnique({ where: { code } });
    if (!group) throw new HttpError(404, "Groupe introuvable");
    await prisma.entity.updateMany({ where: { groupId: group.id }, data: { groupId: null } });
    await prisma.group.delete({ where: { id: group.id } });
    res.json({ ok: true });
  })
);

/**
 * POST /wa/group/assignEntity — body: { entityCode, groupCode }.
 * groupCode omis/null => détache l'établissement de son groupe actuel.
 * Rattacher à un groupe à fidélité centralisée fusionne le solde de
 * l'établissement (par email) dans le solde partagé du groupe ; détacher
 * ne "redescend" pas le solde partagé — l'établissement repart avec un
 * historique propre (le solde du groupe reste intact pour les hôtels
 * restants).
 */
groupRouter.post(
  "/group/assignEntity",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const entityCode = (req.body.entityCode as string) || "";
    const groupCode = (req.body.groupCode as string) || null;

    const entity = await prisma.entity.findUnique({ where: { code: entityCode } });
    if (!entity) throw new HttpError(404, "Établissement introuvable");

    let targetGroup: { id: string; loyaltyMode: string } | null = null;
    if (groupCode) {
      const g = await prisma.group.findUnique({ where: { code: groupCode } });
      if (!g) throw new HttpError(404, "Groupe introuvable");
      targetGroup = g;
    }

    if (targetGroup && targetGroup.loyaltyMode === "centralized") {
      const entityAccounts = await prisma.loyaltyAccount.findMany({ where: { entityId: entity.id } });
      for (const acc of entityAccounts) {
        const shared = await prisma.loyaltyAccount.upsert({
          where: { groupId_email: { groupId: targetGroup.id, email: acc.email } },
          update: { totalPoints: { increment: acc.totalPoints } },
          create: { groupId: targetGroup.id, email: acc.email, totalPoints: acc.totalPoints },
        });
        if (acc.totalPoints !== 0) {
          await prisma.loyaltyTransaction.create({
            data: { accountId: shared.id, earned: Math.max(acc.totalPoints, 0), spent: Math.max(-acc.totalPoints, 0), bookingCode: null },
          });
        }
        await prisma.loyaltyAccount.delete({ where: { id: acc.id } });
      }
    }

    const updated = await prisma.entity.update({
      where: { id: entity.id },
      data: { groupId: targetGroup ? targetGroup.id : null },
    });
    res.json({ ok: true, entityCode: updated.code, groupCode: groupCode || null });
  })
);
