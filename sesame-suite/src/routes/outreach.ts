import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { createOutreachDraft, approveDraft, sendDraft, rejectDraft } from "../lib/outreach";
import { approveProposal, sendProposal, confirmProposal } from "../lib/meetingProposal";
import { runOutreachScanNow } from "../lib/outreachScheduler";

/**
 * Sesame AI Autonomous Prospecting — routes admin P2 (validation/envoi des
 * emails, réponses) + P3 (propositions de rendez-vous). Toute action qui
 * engage réellement (envoi email, création de réunion) passe par une route
 * dédiée séparée de la génération — jamais combinée en un seul appel, pour
 * que l'approbation humaine reste un geste explicite et auditable.
 */
export const outreachRouter = Router();

// ── Config (P2-06 délais de relance) ───────────────────────────────────
outreachRouter.get(
  "/outreachConfig",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const cfg = await prisma.outreachConfig.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
    res.json(cfg);
  })
);

outreachRouter.post(
  "/outreachConfig/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as { relanceDelaysDays?: number[]; maxRelances?: number };
    const cfg = await prisma.outreachConfig.upsert({
      where: { id: "singleton" },
      update: { relanceDelaysDays: Array.isArray(b.relanceDelaysDays) ? b.relanceDelaysDays.map((n) => Math.max(1, Math.round(n))) : undefined, maxRelances: b.maxRelances !== undefined ? Math.max(0, Math.round(b.maxRelances)) : undefined },
      create: { id: "singleton" },
    });
    res.json(cfg);
  })
);

// ── Brouillons d'emails (P2-01 à P2-05) ────────────────────────────────
outreachRouter.get(
  "/outreachDraft/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const prospectId = (req.query.prospectId as string) || undefined;
    const status = (req.query.status as string) || undefined;
    const rows = await prisma.outreachDraft.findMany({
      where: { prospectId, status },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { prospect: { select: { nom: true, secteur: true } } },
    });
    res.json(rows);
  })
);

outreachRouter.post(
  "/outreachDraft/generate",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const prospectId = (req.body.prospectId as string) || "";
    const sequenceStep = Number(req.body.sequenceStep ?? 0);
    if (!prospectId) throw new HttpError(400, "prospectId requis");
    const { draft, skippedReason } = await createOutreachDraft(prospectId, sequenceStep);
    if (!draft) throw new HttpError(400, skippedReason || "Génération impossible");
    res.status(201).json(draft);
  })
);

outreachRouter.post(
  "/outreachDraft/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const { id, subject, bodyHtml } = req.body as { id: string; subject?: string; bodyHtml?: string };
    if (!id) throw new HttpError(400, "id requis");
    const existing = await prisma.outreachDraft.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Brouillon introuvable");
    if (existing.status === "sent") throw new HttpError(400, "Email déjà envoyé — impossible de le modifier");
    // Texte figé après approbation (brief §5) : toute modification repasse en validation.
    const wasApproved = existing.status === "approved";
    const row = await prisma.outreachDraft.update({
      where: { id },
      data: {
        subject: subject !== undefined ? subject : undefined,
        bodyHtml: bodyHtml !== undefined ? bodyHtml : undefined,
        status: wasApproved ? "pending_approval" : undefined,
        approvedById: wasApproved ? null : undefined,
        approvedByName: wasApproved ? null : undefined,
        approvedAt: wasApproved ? null : undefined,
      },
    });
    res.json(row);
  })
);

outreachRouter.post(
  "/outreachDraft/approve",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    if (!id) throw new HttpError(400, "id requis");
    try {
      const row = await approveDraft(id, req.admin!.adminId, req.admin!.email);
      res.json(row);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "Erreur");
    }
  })
);

outreachRouter.post(
  "/outreachDraft/reject",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    if (!id) throw new HttpError(400, "id requis");
    res.json(await rejectDraft(id));
  })
);

outreachRouter.post(
  "/outreachDraft/send",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    if (!id) throw new HttpError(400, "id requis");
    try {
      const row = await sendDraft(id);
      res.json(row);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "Échec de l'envoi");
    }
  })
);

// ── Réponses reçues (P2-07/08) ─────────────────────────────────────────
outreachRouter.get(
  "/outreachReply/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const prospectId = (req.query.prospectId as string) || undefined;
    const rows = await prisma.outreachReply.findMany({
      where: { prospectId },
      orderBy: { receivedAt: "desc" },
      take: 200,
      include: { prospect: { select: { nom: true, secteur: true } } },
    });
    res.json(rows);
  })
);

// ── Propositions de rendez-vous (P3) ───────────────────────────────────
outreachRouter.get(
  "/meetingProposal/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const status = (req.query.status as string) || undefined;
    const rows = await prisma.meetingProposal.findMany({
      where: { status },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { prospect: { select: { nom: true, secteur: true } } },
    });
    res.json(rows);
  })
);

outreachRouter.post(
  "/meetingProposal/approve",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    if (!id) throw new HttpError(400, "id requis");
    res.json(await approveProposal(id, req.admin!.adminId));
  })
);

outreachRouter.post(
  "/meetingProposal/send",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    if (!id) throw new HttpError(400, "id requis");
    try {
      res.json(await sendProposal(id));
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "Échec de l'envoi");
    }
  })
);

/**
 * Confirmation manuelle d'un créneau — filet de rattrapage quand le
 * prospect répond par téléphone, ou quand la réponse email était trop
 * ambiguë pour que l'IA la reconnaisse (P3-06, "réponses ambiguës
 * systématiquement soumises au commercial" : ce bouton EST la soumission
 * au commercial, jamais une confirmation automatique).
 */
outreachRouter.post(
  "/meetingProposal/confirmManual",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const { id, slotIndex } = req.body as { id: string; slotIndex: number };
    if (!id || ![1, 2, 3].includes(slotIndex)) throw new HttpError(400, "id et slotIndex (1-3) requis");
    try {
      res.json(await confirmProposal(id, slotIndex as 1 | 2 | 3));
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "Échec de la confirmation");
    }
  })
);

outreachRouter.post(
  "/outreach/runNow",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    runOutreachScanNow().catch((e) => console.error("[outreach/runNow]", e));
    res.json({ ok: true, message: "Génération lancée en arrière-plan" });
  })
);
