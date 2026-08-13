import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";

export const loyaltyRouter = Router();

/** GET /wa/loyalty/list?entityCode=&email= — solde + historique fidélité. */
loyaltyRouter.get(
  "/loyalty/list",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const email = ((req.query.email as string) || "").trim().toLowerCase();
    if (!email) throw new HttpError(400, "email requis");

    const account = await prisma.loyaltyAccount.findUnique({
      where: { entityId_email: { entityId: entity.id, email } },
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

    const account = await prisma.loyaltyAccount.upsert({
      where: { entityId_email: { entityId: entity.id, email } },
      update: { totalPoints: { increment: earned - spent } },
      create: { entityId: entity.id, email, totalPoints: Math.max(0, earned - spent) },
    });

    if (earned || spent) {
      await prisma.loyaltyTransaction.create({
        data: { accountId: account.id, earned, spent, bookingCode: b.bookingCode || null },
      });
    }

    res.json({ email, total: Math.max(0, account.totalPoints) });
  })
);
