import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { provisionEntity } from "../lib/provisionEntity";
import { fireTrigger } from "../lib/automation";

export const subscriptionRouter = Router();

// ── Grille tarifaire globale (panneau "Souscriptions") ──

subscriptionRouter.get(
  "/pricingConfig",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const cfg = await prisma.pricingConfig.upsert({
      where: { id: "global" },
      update: {},
      create: { id: "global" },
    });
    res.json(cfg);
  })
);

subscriptionRouter.post(
  "/pricingConfig/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as { basePrice?: number; trialDays?: number; modulePrices?: Record<string, number> };
    const cfg = await prisma.pricingConfig.upsert({
      where: { id: "global" },
      update: { basePrice: b.basePrice, trialDays: b.trialDays, modulePrices: b.modulePrices },
      create: { id: "global", basePrice: b.basePrice ?? 49, trialDays: b.trialDays ?? 30, modulePrices: b.modulePrices ?? {} },
    });
    res.json(cfg);
  })
);

// ── Demandes de souscription ──

function shapeSub(s: any) {
  return {
    id: s.id,
    entityId: s.entityId,
    entityCode: s.entity ? s.entity.code : null,
    hotelName: s.hotelName,
    stars: s.stars,
    contact: { email: s.contactEmail, phone: s.contactPhone || "" },
    pmsLabel: s.pmsLabel || "",
    modules: (s.modules as string[]) || [],
    pricing: { basePrice: s.basePrice, modulePrices: s.modulePrices || {}, monthlyTotal: s.monthlyTotal },
    paymentMethod: s.paymentIbanLast4 ? { ibanHolder: s.paymentIbanHolder || "", ibanLast4: s.paymentIbanLast4 } : null,
    status: s.status,
    trialDays: s.trialDays,
    trialEnd: s.trialEnd,
    activatedAt: s.activatedAt,
    createdAt: s.createdAt,
  };
}

subscriptionRouter.get(
  "/subscription/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const subs = await prisma.subscription.findMany({ include: { entity: true }, orderBy: { createdAt: "desc" } });
    res.json(subs.map(shapeSub));
  })
);

interface CreateSubBody {
  hotelName: string;
  stars?: number;
  contactEmail: string;
  contactPhone?: string;
  pmsLabel?: string;
  modules?: string[];
  basePrice: number;
  modulePrices?: Record<string, number>;
  monthlyTotal: number;
  trialDays?: number;
  paymentIbanHolder?: string;
  paymentIbanLast4?: string;
}

subscriptionRouter.post(
  "/subscription/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as CreateSubBody;
    if (!b.hotelName || !b.contactEmail) throw new HttpError(400, "Nom de l'hôtel et email de contact requis");
    const trialDays = b.trialDays ?? 30;
    const trialEnd = new Date(Date.now() + trialDays * 86400000);
    const sub = await prisma.subscription.create({
      data: {
        hotelName: b.hotelName,
        stars: b.stars || 3,
        contactEmail: b.contactEmail,
        contactPhone: b.contactPhone,
        pmsLabel: b.pmsLabel,
        modules: b.modules || [],
        basePrice: b.basePrice,
        modulePrices: b.modulePrices || {},
        monthlyTotal: b.monthlyTotal,
        trialDays,
        trialEnd,
        paymentIbanHolder: b.paymentIbanHolder,
        paymentIbanLast4: b.paymentIbanLast4,
      },
    });
    res.status(201).json(shapeSub(sub));
  })
);

/** POST /wa/subscription/status — body: { id, status }.
 * Passage à "active" sans établissement encore provisionné : crée l'Entity +
 * son compte admin (cf. provisionEntity) et lie la souscription. */
subscriptionRouter.post(
  "/subscription/status",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const { id, status } = req.body as { id: string; status: string };
    const sub = await prisma.subscription.findUnique({ where: { id } });
    if (!sub) throw new HttpError(404, "Souscription introuvable");

    let entityId = sub.entityId;
    let provisioned: { adminEmail: string; adminPassword: string } | null = null;
    if (status === "active" && !entityId) {
      const { entity, adminEmail, adminPassword } = await provisionEntity({ name: sub.hotelName, stars: sub.stars, adminEmail: sub.contactEmail });
      entityId = entity.id;
      provisioned = { adminEmail, adminPassword };
    }

    const updated = await prisma.subscription.update({
      where: { id },
      data: { status, entityId, activatedAt: status === "active" ? new Date() : sub.activatedAt },
      include: { entity: true },
    });

    if (status !== sub.status && (status === "active" || status === "cancelled")) {
      fireTrigger(status === "active" ? "crm.subscription_activated" : "crm.subscription_cancelled", {
        entityId: null,
        targetType: "subscription",
        targetId: updated.id,
        recipient: { email: updated.contactEmail, phone: updated.contactPhone },
        variables: { nom: updated.hotelName, secteur: "" },
      }).catch((e) => console.error(`[automation] crm.subscription_${status}:`, e));
    }

    res.json({ ...shapeSub(updated), provisioned });
  })
);

subscriptionRouter.post(
  "/subscription/extendTrial",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const { id, days } = req.body as { id: string; days: number };
    const sub = await prisma.subscription.findUnique({ where: { id } });
    if (!sub) throw new HttpError(404, "Souscription introuvable");
    const base = sub.trialEnd && sub.trialEnd > new Date() ? sub.trialEnd : new Date();
    const trialEnd = new Date(base.getTime() + days * 86400000);
    const updated = await prisma.subscription.update({ where: { id }, data: { trialEnd, trialDays: sub.trialDays + days } });
    res.json(shapeSub(updated));
  })
);
