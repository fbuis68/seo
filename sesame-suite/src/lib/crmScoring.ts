import { prisma } from "../db";
import type { CrmScoringConfig } from "@prisma/client";

/**
 * Score d'intérêt CRM (08/09/2026) — chaque action qualifiante d'un
 * prospect (email ouvert, clic sur un lien de question, signal reçu du
 * site externe…) passe par recordScoreEvent(), point d'entrée unique qui :
 * journalise l'événement (CrmScoreEvent), incrémente CrmProspect.score,
 * applique le bonus "deux modules distincts vus", et crée automatiquement
 * une tâche commerciale (CrmActivity) au premier franchissement du seuil.
 * Barème et seuil réglables depuis le panneau CRM "Scoring" plutôt que
 * figés en dur (CrmScoringConfig, ligne unique "singleton").
 */

export type ScoreEventType =
  | "email_opened"
  | "module_click"
  | "module_page_visit"
  | "roi_calculator"
  | "two_modules_viewed"
  | "doc_request"
  | "demo_request";

const MODULE_EVENT_TYPES: ScoreEventType[] = ["module_click", "module_page_visit"];

export async function getScoringConfig(): Promise<CrmScoringConfig> {
  return prisma.crmScoringConfig.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
}

function pointsFor(eventType: ScoreEventType, config: CrmScoringConfig): number {
  switch (eventType) {
    case "email_opened":
      return config.pointsEmailOpened;
    case "module_click":
      return config.pointsModuleClick;
    case "module_page_visit":
      return config.pointsModulePageVisit;
    case "roi_calculator":
      return config.pointsRoiCalculator;
    case "two_modules_viewed":
      return config.pointsTwoModulesViewed;
    case "doc_request":
      return config.pointsDocRequest;
    case "demo_request":
      return config.pointsDemoRequest;
  }
}

/**
 * Enregistre un événement de score pour un prospect. `module` est un
 * libellé libre (ex: "Fidélité") — requis pour donner du sens au bonus
 * "deux modules distincts" et au texte de la tâche commerciale, sans objet
 * pour email_opened/doc_request/demo_request/two_modules_viewed.
 * `source` distingue les événements générés par cette app (pixel
 * d'ouverture, clic sur un lien de question) de ceux signalés par le site
 * externe via POST /wa/crmScoring/engagementSignal.
 */
export async function recordScoreEvent(
  prospectId: string,
  eventType: ScoreEventType,
  module?: string | null,
  source: "internal" | "webhook" = "internal"
): Promise<{ score: number; taskCreated: boolean }> {
  const config = await getScoringConfig();
  const points = pointsFor(eventType, config);

  await prisma.crmScoreEvent.create({
    data: { prospectId, eventType, points, module: module || null, source },
  });
  let prospect = await prisma.crmProspect.update({
    where: { id: prospectId },
    data: { score: { increment: points } },
  });

  // Bonus "deux modules distincts vus" — déclenché une seule fois, au
  // moment où le compte de modules distincts (module_click/module_page_visit
  // avec un libellé renseigné) atteint exactement 2.
  if (MODULE_EVENT_TYPES.includes(eventType) && module) {
    const rows = await prisma.crmScoreEvent.findMany({
      where: { prospectId, eventType: { in: MODULE_EVENT_TYPES }, module: { not: null } },
      select: { module: true },
      distinct: ["module"],
    });
    const alreadyBonused = await prisma.crmScoreEvent.findFirst({
      where: { prospectId, eventType: "two_modules_viewed" },
      select: { id: true },
    });
    if (rows.length === 2 && !alreadyBonused) {
      const bonusPoints = pointsFor("two_modules_viewed", config);
      await prisma.crmScoreEvent.create({
        data: { prospectId, eventType: "two_modules_viewed", points: bonusPoints, source: "internal" },
      });
      prospect = await prisma.crmProspect.update({
        where: { id: prospectId },
        data: { score: { increment: bonusPoints } },
      });
    }
  }

  let taskCreated = false;
  if (prospect.score >= config.threshold && !prospect.hotLeadTaskCreatedAt) {
    const moduleRows = await prisma.crmScoreEvent.findMany({
      where: { prospectId, module: { not: null } },
      select: { module: true },
      distinct: ["module"],
    });
    const modules = moduleRows.map((r) => r.module).filter(Boolean) as string[];
    const label = modules.length ? `Contact chaud – intérêt ${modules.join(" + ")} – score ${prospect.score}.` : `Contact chaud – score ${prospect.score}.`;
    await prisma.crmActivity.create({
      data: { prospectId, type: "Tâche commerciale", text: label, authorName: "Scoring CRM" },
    });
    await prisma.crmProspect.update({ where: { id: prospectId }, data: { hotLeadTaskCreatedAt: new Date() } });
    taskCreated = true;
  }

  return { score: prospect.score, taskCreated };
}
