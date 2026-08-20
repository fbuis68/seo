import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";

/**
 * Trésorerie prévisionnelle — modèle simplifié (20/08/2026) : lignes
 * récurrentes génériques (revenu/dépense, sans détail par client ni
 * fournisseur) + bascule saisie globale/détaillée par catégorie et par
 * année (CrmCashSettings). Alimente le panneau Trésorerie de
 * public/crm.html. Réservé aux comptes Sesame.
 */
export const crmCashLineRouter = Router();

const KINDS = ["revenu", "depense", "solde_depart"] as const;
const REVENU_FREQS = ["mensuel", "trimestriel", "ponctuel"] as const;
const DEPENSE_FREQS = ["mensuel", "ponctuel"] as const;
const MODES = ["global", "detail"] as const;

function freqsFor(kind: string): readonly string[] {
  return kind === "depense" ? DEPENSE_FREQS : REVENU_FREQS;
}

function shapeLine(l: {
  id: string;
  annee: number;
  kind: string;
  label: string;
  montant: number;
  frequence: string | null;
  mois: number | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: l.id,
    annee: l.annee,
    kind: l.kind,
    label: l.label,
    montant: l.montant,
    frequence: l.frequence,
    mois: l.mois,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

crmCashLineRouter.get(
  "/crmCashLine/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const annee = req.query.annee ? +req.query.annee : new Date().getFullYear();
    const rows = await prisma.crmCashLine.findMany({
      where: { annee },
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
  frequence?: string | null;
  mois?: number | null;
}

function validateBody(b: LineBody) {
  if (!b.kind || !KINDS.includes(b.kind as (typeof KINDS)[number])) throw new HttpError(400, "kind invalide");
  if (!b.label || !b.label.trim()) throw new HttpError(400, "Libellé requis");
  if (typeof b.montant !== "number" || Number.isNaN(b.montant)) throw new HttpError(400, "Montant invalide");
  if (b.mois !== undefined && b.mois !== null && (b.mois < 0 || b.mois > 11)) throw new HttpError(400, "Mois invalide (0-11)");
  if (b.kind === "revenu" || b.kind === "depense") {
    if (!b.frequence || !freqsFor(b.kind).includes(b.frequence)) {
      throw new HttpError(400, `Fréquence invalide pour "${b.kind}" (${freqsFor(b.kind).join(", ")})`);
    }
  }
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
        frequence: b.kind === "solde_depart" ? null : b.frequence,
        mois: b.mois ?? null,
      },
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
    const existing = await prisma.crmCashLine.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Ligne introuvable");
    if (b.label !== undefined && !b.label.trim()) throw new HttpError(400, "Le libellé ne peut pas être vide");
    if (b.montant !== undefined && (typeof b.montant !== "number" || Number.isNaN(b.montant))) throw new HttpError(400, "Montant invalide");
    if (b.mois !== undefined && b.mois !== null && (b.mois < 0 || b.mois > 11)) throw new HttpError(400, "Mois invalide (0-11)");
    if (b.frequence !== undefined && b.frequence !== null && (existing.kind === "revenu" || existing.kind === "depense")) {
      if (!freqsFor(existing.kind).includes(b.frequence)) {
        throw new HttpError(400, `Fréquence invalide pour "${existing.kind}" (${freqsFor(existing.kind).join(", ")})`);
      }
    }
    const row = await prisma.crmCashLine.update({
      where: { id },
      data: {
        label: b.label?.trim(),
        montant: b.montant,
        frequence: b.frequence,
        mois: b.mois,
      },
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

// ── Bascule saisie globale / détaillée (par catégorie, par année) ──

function shapeSettings(s: {
  id: string;
  annee: number;
  revenuMode: string;
  revenuMontant: number;
  revenuFrequence: string;
  revenuMois: number | null;
  depenseMode: string;
  depenseMontant: number;
  depenseFrequence: string;
  depenseMois: number | null;
}) {
  return {
    id: s.id,
    annee: s.annee,
    revenuMode: s.revenuMode,
    revenuMontant: s.revenuMontant,
    revenuFrequence: s.revenuFrequence,
    revenuMois: s.revenuMois,
    depenseMode: s.depenseMode,
    depenseMontant: s.depenseMontant,
    depenseFrequence: s.depenseFrequence,
    depenseMois: s.depenseMois,
  };
}

crmCashLineRouter.get(
  "/crmCashSettings/get",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const annee = req.query.annee ? +req.query.annee : new Date().getFullYear();
    const row = await prisma.crmCashSettings.upsert({
      where: { annee },
      update: {},
      create: { annee },
    });
    res.json(shapeSettings(row));
  })
);

interface SettingsBody {
  annee?: number;
  revenuMode?: string;
  revenuMontant?: number;
  revenuFrequence?: string;
  revenuMois?: number | null;
  depenseMode?: string;
  depenseMontant?: number;
  depenseFrequence?: string;
  depenseMois?: number | null;
}

crmCashLineRouter.post(
  "/crmCashSettings/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as SettingsBody;
    const annee = b.annee ?? new Date().getFullYear();
    if (b.revenuMode !== undefined && !MODES.includes(b.revenuMode as (typeof MODES)[number])) {
      throw new HttpError(400, "revenuMode invalide (global | detail)");
    }
    if (b.depenseMode !== undefined && !MODES.includes(b.depenseMode as (typeof MODES)[number])) {
      throw new HttpError(400, "depenseMode invalide (global | detail)");
    }
    if (b.revenuFrequence !== undefined && !REVENU_FREQS.includes(b.revenuFrequence as (typeof REVENU_FREQS)[number])) {
      throw new HttpError(400, "revenuFrequence invalide");
    }
    if (b.depenseFrequence !== undefined && !DEPENSE_FREQS.includes(b.depenseFrequence as (typeof DEPENSE_FREQS)[number])) {
      throw new HttpError(400, "depenseFrequence invalide");
    }
    const row = await prisma.crmCashSettings.upsert({
      where: { annee },
      update: {
        revenuMode: b.revenuMode,
        revenuMontant: b.revenuMontant,
        revenuFrequence: b.revenuFrequence,
        revenuMois: b.revenuMois,
        depenseMode: b.depenseMode,
        depenseMontant: b.depenseMontant,
        depenseFrequence: b.depenseFrequence,
        depenseMois: b.depenseMois,
      },
      create: {
        annee,
        revenuMode: b.revenuMode ?? "detail",
        revenuMontant: b.revenuMontant ?? 0,
        revenuFrequence: b.revenuFrequence ?? "mensuel",
        revenuMois: b.revenuMois ?? null,
        depenseMode: b.depenseMode ?? "detail",
        depenseMontant: b.depenseMontant ?? 0,
        depenseFrequence: b.depenseFrequence ?? "mensuel",
        depenseMois: b.depenseMois ?? null,
      },
    });
    res.json(shapeSettings(row));
  })
);
