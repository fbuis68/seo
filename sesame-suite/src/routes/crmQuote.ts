import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { ONBOARDING_MODULES } from "./onboarding";

/**
 * Devis (module "Gestion des affaires", 18/08/2026) — rattachés à une
 * CrmDeal. "Souple" : lignes libres en JSON, mélange de modules Sesame et de
 * lignes personnalisées. "Automatique" : le catalogue de modules proposé
 * pour pré-remplir les lignes vient de la même source de vérité tarifaire
 * que le wizard d'inscription (ONBOARDING_MODULES + PricingConfig), pas
 * d'une grille dupliquée qui risquerait de diverger.
 */
export const crmQuoteRouter = Router();

interface QuoteLine {
  label: string;
  qty: number;
  unitPrice: number;
  recurring: boolean; // true = mensuel (module Sesame), false = ponctuel (frais de mise en place...)
}

function shapeQuote(q: {
  id: string;
  dealId: string;
  number: string;
  status: string;
  lines: unknown;
  discountPct: number;
  notes: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: q.id,
    dealId: q.dealId,
    number: q.number,
    status: q.status,
    lines: (q.lines as QuoteLine[]) || [],
    discountPct: q.discountPct,
    notes: q.notes || "",
    sentAt: q.sentAt,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
  };
}

/** GET /wa/crmQuote/catalog — catalogue de modules + prix pour pré-remplir un devis. */
crmQuoteRouter.get(
  "/crmQuote/catalog",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const cfg = await prisma.pricingConfig.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
    const overrides = (cfg.modulePrices as Record<string, number>) || {};
    res.json({
      basePrice: cfg.basePrice,
      modules: ONBOARDING_MODULES.map((m) => ({ k: m.k, label: m.label, price: overrides[m.k] ?? m.price })),
    });
  })
);

async function nextQuoteNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `DEV-${year}-`;
  const count = await prisma.crmQuote.count({ where: { number: { startsWith: prefix } } });
  for (let i = count + 1; i < count + 50; i++) {
    const candidate = `${prefix}${String(i).padStart(4, "0")}`;
    const exists = await prisma.crmQuote.findUnique({ where: { number: candidate } });
    if (!exists) return candidate;
  }
  // Filet de sécurité improbable (>50 collisions) — timestamp garantit l'unicité.
  return `${prefix}${Date.now()}`;
}

crmQuoteRouter.get(
  "/crmQuote/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const dealId = (req.query.dealId as string) || "";
    if (!dealId) throw new HttpError(400, "dealId requis");
    const rows = await prisma.crmQuote.findMany({ where: { dealId }, orderBy: { createdAt: "desc" } });
    res.json(rows.map(shapeQuote));
  })
);

interface QuoteBody {
  dealId: string;
  lines?: QuoteLine[];
  discountPct?: number;
  notes?: string;
  status?: string;
}

crmQuoteRouter.post(
  "/crmQuote/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as QuoteBody;
    if (!b.dealId) throw new HttpError(400, "dealId requis");
    const deal = await prisma.crmDeal.findUnique({ where: { id: b.dealId } });
    if (!deal) throw new HttpError(404, "Affaire introuvable");
    const number = await nextQuoteNumber();
    const row = await prisma.crmQuote.create({
      data: {
        dealId: b.dealId,
        number,
        lines: (b.lines || []) as object[],
        discountPct: b.discountPct ?? 0,
        notes: b.notes,
      },
    });
    res.status(201).json(shapeQuote(row));
  })
);

crmQuoteRouter.post(
  "/crmQuote/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const { id, ...b } = req.body as QuoteBody & { id: string };
    if (!id) throw new HttpError(400, "id requis");
    const existing = await prisma.crmQuote.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Devis introuvable");
    const row = await prisma.crmQuote.update({
      where: { id },
      data: {
        lines: b.lines === undefined ? undefined : (b.lines as object[]),
        discountPct: b.discountPct,
        notes: b.notes,
        status: b.status,
        sentAt: b.status === "envoyé" && existing.status !== "envoyé" ? new Date() : undefined,
      },
    });
    res.json(shapeQuote(row));
  })
);

crmQuoteRouter.post(
  "/crmQuote/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmQuote.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Devis introuvable");
    await prisma.crmQuote.delete({ where: { id } });
    res.json({ ok: true });
  })
);
