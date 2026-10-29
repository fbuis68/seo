import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { computeSalesScore } from "../lib/aiClaude";
import { config } from "../config";

/**
 * Scoring qualificatif B2B (Sesame AI Sales Agent, §3 du brief) — déclenché
 * à la demande (bouton fiche prospect), jamais en tâche de fond : coût
 * d'un appel Claude par calcul, et l'explicabilité par critère n'a de sens
 * que si un commercial regarde le résultat au moment où il le demande.
 * Chaque calcul s'ajoute en historique (jamais d'écrasement, cf.
 * schema.prisma SalesScore) — le plus récent fait foi pour l'affichage.
 */
export const crmSalesScoreRouter = Router();

function classify(total: number): string {
  if (total >= 85) return "hot_lead";
  if (total >= 70) return "qualified_lead";
  if (total >= 50) return "nurturing";
  return "low_priority";
}

crmSalesScoreRouter.get(
  "/crmSalesScore/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const prospectId = (req.query.prospectId as string) || "";
    if (!prospectId) throw new HttpError(400, "prospectId requis");
    const rows = await prisma.salesScore.findMany({ where: { prospectId }, orderBy: { computedAt: "desc" } });
    res.json(rows);
  })
);

crmSalesScoreRouter.post(
  "/crmSalesScore/compute",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const prospectId = (req.body.prospectId as string) || "";
    if (!prospectId) throw new HttpError(400, "prospectId requis");
    const prospect = await prisma.crmProspect.findUnique({
      where: { id: prospectId },
      select: { nom: true, secteur: true, ville: true, pays: true, effectifSalarie: true, nbAcces: true, contrat: true, detectedProject: true, score: true, commercialId: true },
    });
    if (!prospect) throw new HttpError(404, "Prospect introuvable");

    // Seuls les signaux VÉRIFIÉS ("fact") nourrissent le score — un signal
    // to_verify/hypothesis ne doit jamais faire monter artificiellement la
    // note (§3 du brief).
    const [signals, meetings] = await Promise.all([
      prisma.salesSignal.findMany({ where: { prospectId, status: "fact" }, orderBy: { publishedAt: "desc" }, take: 10 }),
      prisma.crmMeeting.findMany({ where: { prospectId, summaryText: { not: null } }, orderBy: { startDateTime: "desc" }, take: 3, select: { summaryText: true } }),
    ]);

    const result = await computeSalesScore({
      prospectName: prospect.nom,
      secteur: prospect.secteur || undefined,
      ville: prospect.ville || undefined,
      pays: prospect.pays || undefined,
      effectifSalarie: prospect.effectifSalarie || undefined,
      nbAcces: prospect.nbAcces || undefined,
      contrat: prospect.contrat || undefined,
      detectedProject: prospect.detectedProject,
      engagementScore: prospect.score,
      hasAssignedCommercial: !!prospect.commercialId,
      verifiedSignals: signals.map((s) => ({ label: s.signalType, hypothesis: s.hypothesis || undefined, publishedAt: s.publishedAt ? s.publishedAt.toISOString().slice(0, 10) : undefined })),
      recentMeetingSummaries: meetings.map((m) => m.summaryText || "").filter(Boolean),
    });

    const total = result.marketFit + result.recentSignal + result.economicPotential + result.decisionMakerAccess + result.urgency + result.technicalFit + result.dataReliability;
    const classification = classify(total);

    const row = await prisma.salesScore.create({
      data: {
        prospectId,
        marketFit: result.marketFit,
        recentSignal: result.recentSignal,
        economicPotential: result.economicPotential,
        decisionMakerAccess: result.decisionMakerAccess,
        urgency: result.urgency,
        technicalFit: result.technicalFit,
        dataReliability: result.dataReliability,
        total,
        classification,
        justification: result.justification,
      },
    });

    await prisma.agentDecisionLog.create({
      data: {
        agentName: "scoring",
        prospectId,
        inputSummary: `Calcul du score qualificatif B2B — ${prospect.nom} (${signals.length} signal(aux) vérifié(s), ${meetings.length} réunion(s) résumée(s))`,
        outputSummary: `Total ${total}/100 (${classification}) — ${JSON.stringify(result.justification)}`,
        model: config.anthropicModel,
      },
    });

    res.status(201).json(row);
  })
);
