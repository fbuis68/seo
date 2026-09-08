import { Router } from "express";
import { prisma } from "../db";
import { config } from "../config";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { recordScoreEvent, getScoringConfig, ScoreEventType } from "../lib/crmScoring";

/**
 * Score d'intérêt CRM — configuration (barème/seuil, réservé Sesame),
 * historique par fiche, et les deux points d'entrée publics qui alimentent
 * le score : le pixel de suivi d'ouverture d'email et le webhook générique
 * pour un site externe (même principe que /wa/crmProspect/inboundSignal).
 */
export const crmScoringRouter = Router();

function shapeConfig(c: {
  threshold: number;
  pointsEmailOpened: number;
  pointsModuleClick: number;
  pointsModulePageVisit: number;
  pointsRoiCalculator: number;
  pointsTwoModulesViewed: number;
  pointsDocRequest: number;
  pointsDemoRequest: number;
}) {
  return {
    threshold: c.threshold,
    pointsEmailOpened: c.pointsEmailOpened,
    pointsModuleClick: c.pointsModuleClick,
    pointsModulePageVisit: c.pointsModulePageVisit,
    pointsRoiCalculator: c.pointsRoiCalculator,
    pointsTwoModulesViewed: c.pointsTwoModulesViewed,
    pointsDocRequest: c.pointsDocRequest,
    pointsDemoRequest: c.pointsDemoRequest,
  };
}

crmScoringRouter.get(
  "/crmScoring/config",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    res.json(shapeConfig(await getScoringConfig()));
  })
);

interface ConfigBody {
  threshold?: number;
  pointsEmailOpened?: number;
  pointsModuleClick?: number;
  pointsModulePageVisit?: number;
  pointsRoiCalculator?: number;
  pointsTwoModulesViewed?: number;
  pointsDocRequest?: number;
  pointsDemoRequest?: number;
}

crmScoringRouter.post(
  "/crmScoring/config/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as ConfigBody;
    const fields = [
      "threshold",
      "pointsEmailOpened",
      "pointsModuleClick",
      "pointsModulePageVisit",
      "pointsRoiCalculator",
      "pointsTwoModulesViewed",
      "pointsDocRequest",
      "pointsDemoRequest",
    ] as const;
    const data: Record<string, number> = {};
    for (const f of fields) {
      if (b[f] === undefined) continue;
      const n = Number(b[f]);
      if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `Valeur invalide pour ${f}`);
      data[f] = Math.round(n);
    }
    const row = await prisma.crmScoringConfig.upsert({
      where: { id: "singleton" },
      update: data,
      create: { id: "singleton", ...data },
    });
    res.json(shapeConfig(row));
  })
);

/** GET /wa/crmScoring/events?prospectId=... — historique du score d'une fiche. */
crmScoringRouter.get(
  "/crmScoring/events",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const prospectId = (req.query.prospectId as string) || "";
    if (!prospectId) throw new HttpError(400, "prospectId requis");
    const rows = await prisma.crmScoreEvent.findMany({ where: { prospectId }, orderBy: { createdAt: "desc" } });
    res.json(rows.map((r) => ({ id: r.id, eventType: r.eventType, points: r.points, module: r.module, source: r.source, createdAt: r.createdAt })));
  })
);

const EXTERNAL_EVENT_TYPES = new Set<ScoreEventType>(["module_page_visit", "roi_calculator", "doc_request", "demo_request"]);

/**
 * POST /wa/crmScoring/engagementSignal — sans authentification admin (le
 * site externe n'a pas de session CRM), sécurisé par le même secret partagé
 * que /wa/crmProspect/inboundSignal (header X-Inbound-Secret). Réservé aux
 * événements que seul le site externe peut constater — email_opened et
 * module_click ont leurs propres mécanismes internes (pixel, lien
 * traqué) et ne sont volontairement pas acceptés ici.
 */
crmScoringRouter.post(
  "/crmScoring/engagementSignal",
  asyncHandler(async (req, res) => {
    const secret = req.header("X-Inbound-Secret") || "";
    if (secret !== config.inboundEmailSecret) throw new HttpError(401, "Clé invalide");

    const email = ((req.body.email as string) || "").trim();
    const eventType = req.body.eventType as string;
    const moduleLabel = (req.body.module as string) || undefined;
    if (!email) throw new HttpError(400, "email requis");
    if (!EXTERNAL_EVENT_TYPES.has(eventType as ScoreEventType)) {
      throw new HttpError(400, `eventType doit être l'un de : ${[...EXTERNAL_EVENT_TYPES].join(", ")}`);
    }

    const prospect = await prisma.crmProspect.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
    if (!prospect) {
      res.json({ ok: true, matched: false });
      return;
    }
    const result = await recordScoreEvent(prospect.id, eventType as ScoreEventType, moduleLabel, "webhook");
    res.json({ ok: true, matched: true, prospectId: prospect.id, ...result });
  })
);

// 1×1 GIF transparent — https://en.wikipedia.org/wiki/Transparent_pixel, le
// plus petit GIF valide possible (couleur indexée unique, 1 pixel).
const TRACKING_PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7",
  "base64"
);

/**
 * GET /wa/crmScoring/trackOpen?pid=... — image embarquée dans les emails
 * CRM (cf. lib/messaging.ts sendMessage(), option trackOpenProspectId).
 * Répond toujours par le pixel (même prospect introuvable) pour ne jamais
 * casser l'affichage de l'email chez le destinataire.
 */
crmScoringRouter.get(
  "/crmScoring/trackOpen",
  asyncHandler(async (req, res) => {
    const pid = (req.query.pid as string) || "";
    if (pid) {
      const prospect = await prisma.crmProspect.findUnique({ where: { id: pid }, select: { id: true } });
      if (prospect) await recordScoreEvent(prospect.id, "email_opened", null, "internal").catch(() => {});
    }
    res.set("Content-Type", "image/gif");
    res.set("Cache-Control", "no-store");
    res.send(TRACKING_PIXEL);
  })
);
