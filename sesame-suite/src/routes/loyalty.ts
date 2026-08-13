import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { resolveLoyaltyScope } from "../lib/loyaltyScope";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";

export const loyaltyRouter = Router();

/**
 * GET /wa/loyalty/list?entityCode=&email=
 * Avec `email` : solde + historique d'un client (espace client).
 * Sans `email` : liste tous les comptes de l'entité (back-office, protégé).
 *
 * Si l'établissement appartient à un groupe à fidélité centralisée, le
 * solde est celui du groupe (cumulé sur tous ses hôtels) — cf.
 * resolveLoyaltyScope().
 */
loyaltyRouter.get(
  "/loyalty/list",
  (req, res, next) => {
    const email = ((req.query.email as string) || "").trim().toLowerCase();
    if (!email) requireAdmin(req, res, next);
    else next();
  },
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const email = ((req.query.email as string) || "").trim().toLowerCase();
    const scope = await resolveLoyaltyScope(entity);

    if (!email) {
      const accounts = await prisma.loyaltyAccount.findMany({
        where: scope.groupId ? { groupId: scope.groupId } : { entityId: scope.entityId },
        orderBy: { totalPoints: "desc" },
      });
      res.json(accounts.map((a) => ({ email: a.email, total: a.totalPoints })));
      return;
    }

    const account = await prisma.loyaltyAccount.findUnique({
      where: scope.groupId
        ? { groupId_email: { groupId: scope.groupId, email } }
        : { entityId_email: { entityId: scope.entityId as string, email } },
      include: { transactions: { orderBy: { createdAt: "desc" }, take: 20 } },
    });

    res.json({
      email,
      total: account?.totalPoints || 0,
      history: (account?.transactions || []).map((t) => ({
        date: t.createdAt.toISOString(),
        earned: t.earned,
        spent: t.spent,
        booking: t.bookingCode || "",
      })),
    });
  })
);

/** POST /wa/loyalty/reset — body: { email } — remise à zéro (back-office). */
loyaltyRouter.post(
  "/loyalty/reset",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const email = ((req.body.email as string) || "").trim().toLowerCase();
    if (!email) throw new HttpError(400, "email requis");
    const scope = await resolveLoyaltyScope(entity);
    const account = await prisma.loyaltyAccount.update({
      where: scope.groupId
        ? { groupId_email: { groupId: scope.groupId, email } }
        : { entityId_email: { entityId: scope.entityId as string, email } },
      data: { totalPoints: 0 },
    });
    res.json({ email, total: account.totalPoints });
  })
);

/**
 * POST /wa/loyalty/credit
 * body: { email, earned, spent, bookingCode }
 * Remplace loadPointsBalance()/savePointsBalance() (localStorage par email) —
 * appelé à la finalisation du check-in (creditPointsAfterStay()).
 */
loyaltyRouter.post(
  "/loyalty/credit",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as { email: string; earned?: number; spent?: number; bookingCode?: string };
    const email = (b.email || "").trim().toLowerCase();
    if (!email) throw new HttpError(400, "email requis");

    const earned = b.earned || 0;
    const spent = b.spent || 0;
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
        data: { accountId: account.id, earned, spent, bookingCode: b.bookingCode || null },
      });
    }

    res.json({ email, total: Math.max(0, account.totalPoints) });
  })
);
