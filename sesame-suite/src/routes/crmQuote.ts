import { Router } from "express";
import crypto from "node:crypto";
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
  description?: string; // sous-texte verbeux affiché sous le libellé (cf. devis Sesame réels)
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
  signToken: string | null;
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
    signToken: q.signToken,
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

/**
 * POST /wa/crmQuote/duplicate — clone un devis existant (nouvelle version
 * pour la même affaire, ex. après une remise négociée) : mêmes lignes/
 * remise/notes, nouveau numéro, statut réinitialisé à "brouillon", pas de
 * lien vers la signature/l'envoi du devis d'origine.
 */
crmQuoteRouter.post(
  "/crmQuote/duplicate",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmQuote.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Devis introuvable");
    const number = await nextQuoteNumber();
    const row = await prisma.crmQuote.create({
      data: {
        dealId: existing.dealId,
        number,
        lines: existing.lines as object[],
        discountPct: existing.discountPct,
        notes: existing.notes,
      },
    });
    res.status(201).json(shapeQuote(row));
  })
);

// ── Modèles de devis récurrents ──
// Objectif explicite : gagner du temps sur des devis verbeux et répétitifs
// — un modèle porte déjà tous les libellés/descriptions/prix, il ne reste
// qu'à ajuster les quantités à la marge lors de la création d'un devis.

function shapeTemplate(t: { id: string; name: string; lines: unknown; notes: string | null; createdAt: Date; updatedAt: Date }) {
  return {
    id: t.id,
    name: t.name,
    lines: (t.lines as QuoteLine[]) || [],
    notes: t.notes || "",
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

crmQuoteRouter.get(
  "/crmQuoteTemplate/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.crmQuoteTemplate.findMany({ orderBy: { name: "asc" } });
    res.json(rows.map(shapeTemplate));
  })
);

interface TemplateBody {
  name: string;
  lines?: QuoteLine[];
  notes?: string;
}

crmQuoteRouter.post(
  "/crmQuoteTemplate/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as TemplateBody;
    if (!b.name || !b.name.trim()) throw new HttpError(400, "Nom du modèle requis");
    const row = await prisma.crmQuoteTemplate.create({
      data: { name: b.name.trim(), lines: (b.lines || []) as object[], notes: b.notes },
    });
    res.status(201).json(shapeTemplate(row));
  })
);

crmQuoteRouter.post(
  "/crmQuoteTemplate/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const { id, ...b } = req.body as TemplateBody & { id: string };
    if (!id) throw new HttpError(400, "id requis");
    if (b.name !== undefined && !b.name.trim()) throw new HttpError(400, "Le nom ne peut pas être vide");
    const existing = await prisma.crmQuoteTemplate.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Modèle introuvable");
    const row = await prisma.crmQuoteTemplate.update({
      where: { id },
      data: {
        name: b.name?.trim(),
        lines: b.lines === undefined ? undefined : (b.lines as object[]),
        notes: b.notes,
      },
    });
    res.json(shapeTemplate(row));
  })
);

crmQuoteRouter.post(
  "/crmQuoteTemplate/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmQuoteTemplate.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Modèle introuvable");
    await prisma.crmQuoteTemplate.delete({ where: { id } });
    res.json({ ok: true });
  })
);

// ── Signature électronique simple ──
// Volontairement pas une signature électronique qualifiée (eIDAS) — capture
// nom saisi + tracé (canvas) + horodatage/IP/user-agent à titre de preuve
// de consentement, à la manière d'un "clic pour accepter" plutôt qu'une
// signature certifiée par un tiers de confiance (Yousign/DocuSign...). Le
// front-end doit afficher cette nuance clairement au signataire.

function quoteTotals(lines: QuoteLine[], discountPct: number) {
  let mrr = 0;
  let oneoff = 0;
  for (const l of lines) {
    const t = (l.qty || 0) * (l.unitPrice || 0);
    if (l.recurring) mrr += t;
    else oneoff += t;
  }
  const factor = 1 - (discountPct || 0) / 100;
  return { mrr, oneoff, mrrNet: mrr * factor, oneoffNet: oneoff * factor };
}

/**
 * POST /wa/crmQuote/requestSignature — génère (ou réutilise) le token
 * d'accès à la page publique de signature et marque le devis "envoyé".
 */
crmQuoteRouter.post(
  "/crmQuote/requestSignature",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmQuote.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Devis introuvable");
    if (existing.status === "accepté") throw new HttpError(400, "Ce devis est déjà signé");
    const signToken = existing.signToken || crypto.randomBytes(24).toString("hex");
    const row = await prisma.crmQuote.update({
      where: { id },
      data: {
        signToken,
        status: existing.status === "brouillon" ? "envoyé" : undefined,
        sentAt: existing.sentAt ?? new Date(),
      },
    });
    res.json(shapeQuote(row));
  })
);

/**
 * GET /wa/crmQuote/public?token=... — lecture seule, sans authentification
 * (le signataire n'a pas de compte CRM). N'expose que le nécessaire pour
 * afficher le devis à signer.
 */
crmQuoteRouter.get(
  "/crmQuote/public",
  asyncHandler(async (req, res) => {
    const token = (req.query.token as string) || "";
    if (!token) throw new HttpError(400, "Lien invalide");
    const quote = await prisma.crmQuote.findUnique({
      where: { signToken: token },
      include: { deal: { include: { prospect: { select: { nom: true } } } }, signature: true },
    });
    if (!quote) throw new HttpError(404, "Lien de signature invalide ou expiré");
    const lines = (quote.lines as unknown as QuoteLine[]) || [];
    res.json({
      number: quote.number,
      status: quote.status,
      lines,
      discountPct: quote.discountPct,
      notes: quote.notes || "",
      totals: quoteTotals(lines, quote.discountPct),
      dealTitle: quote.deal.title,
      prospectNom: quote.deal.prospect.nom,
      alreadySigned: !!quote.signature,
      signedAt: quote.signature?.signedAt || null,
      signerName: quote.signature?.signerName || null,
    });
  })
);

interface SignBody {
  token: string;
  signerName: string;
  signerEmail?: string;
  signatureDataUrl: string;
  consent: boolean;
}

/**
 * POST /wa/crmQuote/sign — enregistre la signature et fait passer
 * automatiquement le statut du devis à "accepté" et l'affaire à "Gagné"
 * (comportement explicitement demandé).
 */
crmQuoteRouter.post(
  "/crmQuote/sign",
  asyncHandler(async (req, res) => {
    const b = req.body as SignBody;
    if (!b.token) throw new HttpError(400, "Lien invalide");
    if (!b.consent) throw new HttpError(400, "Le consentement est requis pour signer");
    if (!b.signerName || !b.signerName.trim()) throw new HttpError(400, "Nom du signataire requis");
    if (!b.signatureDataUrl) throw new HttpError(400, "Signature requise");

    const quote = await prisma.crmQuote.findUnique({ where: { signToken: b.token }, include: { signature: true } });
    if (!quote) throw new HttpError(404, "Lien de signature invalide ou expiré");
    if (quote.signature) throw new HttpError(400, "Ce devis a déjà été signé");

    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || undefined;

    await prisma.$transaction([
      prisma.crmQuoteSignature.create({
        data: {
          quoteId: quote.id,
          signerName: b.signerName.trim(),
          signerEmail: b.signerEmail?.trim() || undefined,
          signatureDataUrl: b.signatureDataUrl,
          ip,
          userAgent: req.headers["user-agent"] || undefined,
        },
      }),
      prisma.crmQuote.update({ where: { id: quote.id }, data: { status: "accepté" } }),
      prisma.crmDeal.update({ where: { id: quote.dealId }, data: { stage: "Gagné" } }),
    ]);

    res.json({ ok: true });
  })
);
