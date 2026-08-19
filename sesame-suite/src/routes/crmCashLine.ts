import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";

/**
 * Trésorerie prévisionnelle — lignes datées (Signé / Pipeline / Dépenses /
 * Solde de départ) qui alimentent la "Vision annuelle" du panneau
 * Trésorerie de public/crm.html (mock-up validé le 19/08/2026, cf. README).
 * Le MRR reste porté par CrmProspect.mrr — pas de ligne dédiée ici.
 * Réservé aux comptes Sesame, comme le reste du CRM interne.
 */
export const crmCashLineRouter = Router();

const KINDS = ["signe", "pipeline", "depense", "solde_depart"] as const;

function shapeLine(l: {
  id: string;
  annee: number;
  kind: string;
  label: string;
  montant: number;
  proba: number | null;
  mois: number | null;
  prospectId: string | null;
  prospect?: { nom: string } | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: l.id,
    annee: l.annee,
    kind: l.kind,
    label: l.label,
    montant: l.montant,
    proba: l.proba,
    mois: l.mois,
    prospectId: l.prospectId,
    prospectNom: l.prospect ? l.prospect.nom : "",
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

const LINE_INCLUDE = { prospect: { select: { nom: true } } };

crmCashLineRouter.get(
  "/crmCashLine/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const annee = req.query.annee ? +req.query.annee : new Date().getFullYear();
    const rows = await prisma.crmCashLine.findMany({
      where: { annee },
      include: LINE_INCLUDE,
      orderBy: [{ kind: "asc" }, { mois: "asc" }, { label: "asc" }],
    });
    res.json(rows.map(shapeLine));
  })
);

interface LineBody {
  annee?: number;
  kind: string;
  label: string;
  montant: number;
  proba?: number | null;
  mois?: number | null;
  prospectId?: string | null;
}

function validateBody(b: LineBody) {
  if (!b.kind || !KINDS.includes(b.kind as (typeof KINDS)[number])) throw new HttpError(400, "kind invalide");
  if (!b.label || !b.label.trim()) throw new HttpError(400, "Libellé requis");
  if (typeof b.montant !== "number" || Number.isNaN(b.montant)) throw new HttpError(400, "Montant invalide");
  if (b.mois !== undefined && b.mois !== null && (b.mois < 0 || b.mois > 11)) throw new HttpError(400, "Mois invalide (0-11)");
  if (b.proba !== undefined && b.proba !== null && (b.proba < 0 || b.proba > 100)) throw new HttpError(400, "Probabilité invalide (0-100)");
}

crmCashLineRouter.post(
  "/crmCashLine/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as LineBody;
    validateBody(b);
    const row = await prisma.crmCashLine.create({
      data: {
        annee: b.annee ?? new Date().getFullYear(),
        kind: b.kind,
        label: b.label.trim(),
        montant: b.montant,
        proba: b.kind === "pipeline" ? b.proba ?? 50 : null,
        mois: b.mois ?? null,
        prospectId: b.prospectId || null,
      },
      include: LINE_INCLUDE,
    });
    res.status(201).json(shapeLine(row));
  })
);

crmCashLineRouter.post(
  "/crmCashLine/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const { id, ...rest } = req.body as LineBody & { id: string };
    if (!id) throw new HttpError(400, "id requis");
    const b = rest;
    if (b.label !== undefined && !b.label.trim()) throw new HttpError(400, "Le libellé ne peut pas être vide");
    if (b.montant !== undefined && (typeof b.montant !== "number" || Number.isNaN(b.montant))) throw new HttpError(400, "Montant invalide");
    if (b.mois !== undefined && b.mois !== null && (b.mois < 0 || b.mois > 11)) throw new HttpError(400, "Mois invalide (0-11)");
    if (b.proba !== undefined && b.proba !== null && (b.proba < 0 || b.proba > 100)) throw new HttpError(400, "Probabilité invalide (0-100)");
    const existing = await prisma.crmCashLine.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Ligne introuvable");
    const row = await prisma.crmCashLine.update({
      where: { id },
      data: {
        label: b.label?.trim(),
        montant: b.montant,
        proba: b.proba,
        mois: b.mois,
        prospectId: b.prospectId === undefined ? undefined : b.prospectId || null,
      },
      include: LINE_INCLUDE,
    });
    res.json(shapeLine(row));
  })
);

crmCashLineRouter.post(
  "/crmCashLine/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmCashLine.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Ligne introuvable");
    await prisma.crmCashLine.delete({ where: { id } });
    res.json({ ok: true });
  })
);
