import { Router } from "express";
import { prisma } from "../db";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { asyncHandler } from "../lib/asyncHandler";

/**
 * Journal d'audit des agents IA (§7 conformité du brief Sesame AI Sales
 * Agent, 28/10/2026) — lecture seule, jamais modifiable depuis l'UI : une
 * entrée AgentDecisionLog (écrite par lib/marketIntelligenceScheduler.ts,
 * et par tout futur agent) doit rester consultable telle quelle, preuve de
 * ce que l'IA a effectivement vu/produit à un instant donné.
 */
export const agentDecisionLogRouter = Router();

agentDecisionLogRouter.get(
  "/agentDecisionLog/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const prospectId = (req.query.prospectId as string) || undefined;
    const agentName = (req.query.agentName as string) || undefined;
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = await prisma.agentDecisionLog.findMany({
      where: { ...(prospectId ? { prospectId } : {}), ...(agentName ? { agentName } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    const prospectIds = [...new Set(rows.map((r) => r.prospectId).filter(Boolean))] as string[];
    const prospects = prospectIds.length
      ? await prisma.crmProspect.findMany({ where: { id: { in: prospectIds } }, select: { id: true, nom: true } })
      : [];
    const nameById = new Map(prospects.map((p) => [p.id, p.nom]));
    res.json(
      rows.map((r) => ({
        id: r.id,
        agentName: r.agentName,
        prospectId: r.prospectId,
        prospectName: r.prospectId ? nameById.get(r.prospectId) || null : null,
        signalId: r.signalId,
        inputSummary: r.inputSummary,
        outputSummary: r.outputSummary,
        model: r.model,
        costUsd: r.costUsd,
        createdAt: r.createdAt,
      }))
    );
  })
);
