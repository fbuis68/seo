import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";

/**
 * Module "Gestion des affaires" — pipeline commercial greffé sur le CRM
 * Sesame (18/08/2026). Une affaire (CrmDeal) est une opportunité de vente
 * rattachée à une fiche CrmProspect, avec une étape/valeur/probabilité pour
 * alimenter les KPI de pipe (voir crmQuote.ts pour les devis rattachés).
 * Réservé aux comptes Sesame, comme le reste du CRM interne.
 */
export const crmDealRouter = Router();

export const DEAL_STAGES = ["Nouveau", "Qualification", "Devis envoyé", "Négociation", "Gagné", "Perdu"] as const;

function shapeDeal(d: {
  id: string;
  prospectId: string;
  commercialId: string | null;
  title: string;
  stage: string;
  amount: number;
  probability: number;
  closeDate: Date | null;
  lostReason: string | null;
  montantPonctuel: number | null;
  moisEncaissement: number | null;
  createdAt: Date;
  updatedAt: Date;
  prospect?: { nom: string } | null;
  commercial?: { id: string; name: string | null; email: string } | null;
  quotes?: { id: string; number: string; status: string }[];
}) {
  return {
    id: d.id,
    prospectId: d.prospectId,
    prospectNom: d.prospect ? d.prospect.nom : "",
    commercialId: d.commercialId,
    commercialName: d.commercial ? d.commercial.name || d.commercial.email : "",
    title: d.title,
    stage: d.stage,
    amount: d.amount,
    probability: d.probability,
    closeDate: d.closeDate,
    lostReason: d.lostReason || "",
    montantPonctuel: d.montantPonctuel,
    moisEncaissement: d.moisEncaissement,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    quotes: (d.quotes || []).map((q) => ({ id: q.id, number: q.number, status: q.status })),
  };
}

const DEAL_INCLUDE = {
  prospect: { select: { nom: true } },
  commercial: { select: { id: true, name: true, email: true } },
  quotes: { select: { id: true, number: true, status: true }, orderBy: { createdAt: "desc" as const } },
};

crmDealRouter.get(
  "/crmDeal/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const prospectId = (req.query.prospectId as string) || undefined;
    const rows = await prisma.crmDeal.findMany({
      where: prospectId ? { prospectId } : undefined,
      include: DEAL_INCLUDE,
      orderBy: { updatedAt: "desc" },
    });
    res.json(rows.map(shapeDeal));
  })
);

interface DealBody {
  prospectId: string;
  commercialId?: string | null;
  title: string;
  stage?: string;
  amount?: number;
  probability?: number;
  closeDate?: string | null;
  lostReason?: string;
  montantPonctuel?: number | null;
  moisEncaissement?: number | null;
}

function validateMoisEncaissement(mois: number | null | undefined) {
  if (mois !== undefined && mois !== null && (mois < 0 || mois > 11)) {
    throw new HttpError(400, "Mois d'encaissement invalide (0-11)");
  }
}

crmDealRouter.post(
  "/crmDeal/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as DealBody;
    if (!b.prospectId) throw new HttpError(400, "prospectId requis");
    if (!b.title || !b.title.trim()) throw new HttpError(400, "Titre de l'affaire requis");
    validateMoisEncaissement(b.moisEncaissement);
    const prospect = await prisma.crmProspect.findUnique({ where: { id: b.prospectId } });
    if (!prospect) throw new HttpError(404, "Fiche CRM introuvable");
    const row = await prisma.crmDeal.create({
      data: {
        prospectId: b.prospectId,
        commercialId: b.commercialId || prospect.commercialId || null,
        title: b.title.trim(),
        stage: b.stage || "Nouveau",
        amount: b.amount ?? 0,
        probability: b.probability ?? 20,
        closeDate: b.closeDate ? new Date(b.closeDate) : null,
        montantPonctuel: b.montantPonctuel ?? null,
        moisEncaissement: b.moisEncaissement ?? null,
      },
      include: DEAL_INCLUDE,
    });
    res.status(201).json(shapeDeal(row));
  })
);

crmDealRouter.post(
  "/crmDeal/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const { id, ...b } = req.body as DealBody & { id: string };
    if (!id) throw new HttpError(400, "id requis");
    if (b.title !== undefined && !b.title.trim()) throw new HttpError(400, "Le titre ne peut pas être vide");
    if (b.stage !== undefined && !DEAL_STAGES.includes(b.stage as (typeof DEAL_STAGES)[number])) {
      throw new HttpError(400, "Étape invalide");
    }
    validateMoisEncaissement(b.moisEncaissement);
    const existing = await prisma.crmDeal.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Affaire introuvable");
    const row = await prisma.crmDeal.update({
      where: { id },
      data: {
        commercialId: b.commercialId === undefined ? undefined : b.commercialId || null,
        title: b.title?.trim(),
        stage: b.stage,
        amount: b.amount,
        probability: b.probability,
        closeDate: b.closeDate === undefined ? undefined : b.closeDate ? new Date(b.closeDate) : null,
        lostReason: b.lostReason,
        montantPonctuel: b.montantPonctuel === undefined ? undefined : b.montantPonctuel,
        moisEncaissement: b.moisEncaissement === undefined ? undefined : b.moisEncaissement,
      },
      include: DEAL_INCLUDE,
    });
    res.json(shapeDeal(row));
  })
);

crmDealRouter.post(
  "/crmDeal/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmDeal.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Affaire introuvable");
    await prisma.crmDeal.delete({ where: { id } });
    res.json({ ok: true });
  })
);
