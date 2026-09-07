import { Router } from "express";
import crypto from "node:crypto";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { fireTrigger } from "../lib/automation";
import { QUALIFICATION_MODULES } from "../lib/qualificationModules";

/**
 * Questionnaire de qualification (07/09/2026) — un lien public par contact
 * CRM (client puis prospect) pour qu'il indique lui-même son intérêt pour
 * chaque module du catalogue Souscriptions. Même principe que
 * CrmQuote.signToken/CrmTicket.publicToken : /wa/crmQualification/public et
 * /wa/crmQualification/submit sont volontairement SANS authentification (le
 * répondant n'a pas de compte CRM), le reste du fichier est réservé Sesame.
 */
export const crmQualificationRouter = Router();

const VALID_INTEREST = new Set(["oui", "non", "peut-etre"]);

/** GET /wa/crmQualification/modules — catalogue des questions, pour l'aperçu côté CRM avant envoi. */
crmQualificationRouter.get(
  "/crmQualification/modules",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    res.json(QUALIFICATION_MODULES);
  })
);

/**
 * POST /wa/crmQualification/prepareLinks — body: { ids: string[] }
 * Génère (ou réutilise) le qualificationToken de chaque contact sélectionné
 * et renvoie les liens prêts à insérer dans un envoi groupé (cf. crm.html,
 * qui boucle ensuite sur /wa/message/send comme pour un email groupé
 * classique — pas de pipeline d'envoi dédié ici, juste la préparation des
 * tokens/liens).
 */
crmQualificationRouter.post(
  "/crmQualification/prepareLinks",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? (req.body.ids as string[]) : [];
    if (!ids.length) throw new HttpError(400, "Aucune fiche sélectionnée");
    const proto = req.get("x-forwarded-proto") || req.protocol;
    const host = req.get("host");
    const base = `${proto}://${host}`;

    const rows = await prisma.crmProspect.findMany({ where: { id: { in: ids } } });
    const links: Record<string, string> = {};
    for (const p of rows) {
      const token = p.qualificationToken || crypto.randomBytes(24).toString("hex");
      if (!p.qualificationToken) {
        await prisma.crmProspect.update({ where: { id: p.id }, data: { qualificationToken: token } });
      }
      links[p.id] = `${base}/qualification.html?token=${token}`;
    }
    res.json({ links });
  })
);

/** POST /wa/crmQualification/markSent — body: { ids: string[] } — marque le dernier envoi (appelé après les /wa/message/send individuels). */
crmQualificationRouter.post(
  "/crmQualification/markSent",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? (req.body.ids as string[]) : [];
    if (!ids.length) throw new HttpError(400, "Aucune fiche sélectionnée");
    await prisma.crmProspect.updateMany({ where: { id: { in: ids } }, data: { qualificationSentAt: new Date() } });
    res.json({ ok: true });
  })
);

/**
 * GET /wa/crmQualification/public?token=... — lecture seule, sans
 * authentification (le répondant n'a pas de compte CRM).
 */
crmQualificationRouter.get(
  "/crmQualification/public",
  asyncHandler(async (req, res) => {
    const token = (req.query.token as string) || "";
    if (!token) throw new HttpError(400, "Lien invalide");
    const prospect = await prisma.crmProspect.findUnique({
      where: { qualificationToken: token },
      include: { qualificationResponses: true },
    });
    if (!prospect) throw new HttpError(404, "Lien invalide ou expiré");
    res.json({
      nom: prospect.nom,
      modules: QUALIFICATION_MODULES,
      responses: prospect.qualificationResponses.map((r) => ({ moduleKey: r.moduleKey, interested: r.interested, note: r.note || "" })),
    });
  })
);

interface SubmitBody {
  token: string;
  responses: { moduleKey: string; interested: string; note?: string }[];
}

/**
 * POST /wa/crmQualification/submit — enregistre (upsert) les réponses du
 * contact. Rejoue possible sans casser (un contact qui répond deux fois via
 * le même lien voit ses réponses mises à jour, pas dupliquées).
 */
crmQualificationRouter.post(
  "/crmQualification/submit",
  asyncHandler(async (req, res) => {
    const b = req.body as SubmitBody;
    if (!b.token) throw new HttpError(400, "Lien invalide");
    if (!Array.isArray(b.responses) || !b.responses.length) throw new HttpError(400, "Aucune réponse reçue");

    const prospect = await prisma.crmProspect.findUnique({ where: { qualificationToken: b.token } });
    if (!prospect) throw new HttpError(404, "Lien invalide ou expiré");

    const validModuleKeys = new Set(QUALIFICATION_MODULES.map((m) => m.key));
    const clean = b.responses.filter((r) => validModuleKeys.has(r.moduleKey) && VALID_INTEREST.has(r.interested));
    if (!clean.length) throw new HttpError(400, "Réponses invalides");

    await prisma.$transaction(
      clean.map((r) =>
        prisma.crmQualificationResponse.upsert({
          where: { prospectId_moduleKey: { prospectId: prospect.id, moduleKey: r.moduleKey } },
          update: { interested: r.interested, note: r.note?.trim() || null },
          create: { prospectId: prospect.id, moduleKey: r.moduleKey, interested: r.interested, note: r.note?.trim() || null },
        })
      )
    );

    const interestedCount = clean.filter((r) => r.interested === "oui").length;
    await prisma.crmActivity.create({
      data: {
        prospectId: prospect.id,
        type: "Note interne",
        text: `Questionnaire de qualification complété (${clean.length} module(s) répondu(s), ${interestedCount} intérêt exprimé).`,
        authorName: "Questionnaire",
      },
    });

    fireTrigger("crm.qualification_submitted", {
      entityId: null,
      targetType: "crmProspect",
      targetId: prospect.id,
      recipient: { email: prospect.email, phone: prospect.tel },
      variables: { nom: prospect.nom, secteur: prospect.secteur || "" },
    }).catch((e) => console.error("[automation] crm.qualification_submitted:", e));

    res.json({ ok: true });
  })
);
