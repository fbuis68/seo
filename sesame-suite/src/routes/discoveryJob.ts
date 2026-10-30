import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { MARCHES, MARCHE_DEFS } from "../lib/marketHunter";
import { runMarketHunterScanNow } from "../lib/marketHunterScheduler";

/**
 * Sesame AI Autonomous Prospecting — fondations P0 (config/quotas/arrêt
 * d'urgence/suppressions) + pilotage P1 (jobs/rapport hebdo/lancement
 * manuel). Routes internes "/wa" (pas les chemins /api/v1/... du cahier
 * des charges, qui décrit une API cible générique, pas l'API déjà en place
 * ici — même convention que tout le reste de ce backend).
 */
export const discoveryJobRouter = Router();

function startOfIsoWeek(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

// ── Configuration (P0-01, P0-10) ───────────────────────────────────────
discoveryJobRouter.get(
  "/prospectingConfig",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const cfg = await prisma.prospectingConfig.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
    res.json(cfg);
  })
);

interface ConfigBody {
  quotaHotel?: number;
  quotaPadel?: number;
  quotaResidence?: number;
  emergencyStopped?: boolean;
}

discoveryJobRouter.post(
  "/prospectingConfig/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as ConfigBody;
    const cfg = await prisma.prospectingConfig.upsert({
      where: { id: "singleton" },
      update: {
        quotaHotel: b.quotaHotel !== undefined ? Math.max(0, Math.round(b.quotaHotel)) : undefined,
        quotaPadel: b.quotaPadel !== undefined ? Math.max(0, Math.round(b.quotaPadel)) : undefined,
        quotaResidence: b.quotaResidence !== undefined ? Math.max(0, Math.round(b.quotaResidence)) : undefined,
        emergencyStopped: b.emergencyStopped,
      },
      create: {
        id: "singleton",
        quotaHotel: b.quotaHotel !== undefined ? Math.max(0, Math.round(b.quotaHotel)) : undefined,
        quotaPadel: b.quotaPadel !== undefined ? Math.max(0, Math.round(b.quotaPadel)) : undefined,
        quotaResidence: b.quotaResidence !== undefined ? Math.max(0, Math.round(b.quotaResidence)) : undefined,
        emergencyStopped: b.emergencyStopped,
      },
    });
    res.json(cfg);
  })
);

// ── Suppressions / exclusions (P0-09) ──────────────────────────────────
discoveryJobRouter.get(
  "/suppression/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.suppression.findMany({ orderBy: { createdAt: "desc" }, take: 500 });
    res.json(rows);
  })
);

interface SuppressionBody {
  email?: string;
  siren?: string;
  companyName?: string;
  motif: string;
  perimetre?: string;
}

discoveryJobRouter.post(
  "/suppression/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as SuppressionBody;
    if (!b.motif || !b.motif.trim()) throw new HttpError(400, "Motif requis");
    if (!b.email?.trim() && !b.siren?.trim() && !b.companyName?.trim()) throw new HttpError(400, "Renseignez au moins un email, un SIREN ou un nom d'entreprise");
    const row = await prisma.suppression.create({
      data: {
        email: b.email?.trim() || null,
        siren: b.siren?.trim() || null,
        companyName: b.companyName?.trim() || null,
        motif: b.motif.trim(),
        perimetre: b.perimetre || "total",
      },
    });
    res.status(201).json(row);
  })
);

discoveryJobRouter.post(
  "/suppression/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.suppression.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Introuvable");
    await prisma.suppression.delete({ where: { id } });
    res.json({ ok: true });
  })
);

// ── Jobs / rapport hebdomadaire (P1-11, P1-12) ─────────────────────────
discoveryJobRouter.get(
  "/discoveryJob/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.discoveryJob.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
    res.json(rows);
  })
);

discoveryJobRouter.get(
  "/discoveryJob/weeklyReport",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const cfg = await prisma.prospectingConfig.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
    const weekStart = startOfIsoWeek(new Date());
    const quotas: Record<string, number> = { hotel: cfg.quotaHotel, padel: cfg.quotaPadel, residence: cfg.quotaResidence };

    const byMarket = await Promise.all(
      MARCHES.map(async (marche) => {
        const def = MARCHE_DEFS[marche];
        const [qualified, jobsThisWeek] = await Promise.all([
          prisma.crmProspect.count({ where: { secteur: def.secteur, origine: "Market Hunter IA", createdAt: { gte: weekStart } } }),
          prisma.discoveryJob.findMany({ where: { marche, createdAt: { gte: weekStart } }, select: { foundCount: true, excludedCount: true, status: true } }),
        ]);
        const found = jobsThisWeek.reduce((s, j) => s + j.foundCount, 0);
        const excluded = jobsThisWeek.reduce((s, j) => s + j.excludedCount, 0);
        const quota = quotas[marche] || 0;
        return { marche, label: def.label, quota, qualified, remaining: Math.max(0, quota - qualified), found, excluded, atQuota: qualified >= quota && quota > 0 };
      })
    );

    res.json({ weekStart, emergencyStopped: cfg.emergencyStopped, byMarket });
  })
);

discoveryJobRouter.post(
  "/discoveryJob/runNow",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    runMarketHunterScanNow().catch((e) => console.error("[discoveryJob/runNow]", e));
    res.json({ ok: true, message: "Scan lancé en arrière-plan" });
  })
);
