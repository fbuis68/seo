import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";

/**
 * Signaux d'achat (Sesame AI Sales Agent, 28/10/2026) — création manuelle
 * (ex. post LinkedIn repéré par le commercial via Sales Navigator, pas d'API
 * LinkedIn pour lire l'activité d'un tiers) en complément des signaux
 * générés par l'Agent Market Intelligence (cf.
 * lib/marketIntelligenceScheduler.ts). `url` reste obligatoire (cf.
 * schema.prisma SalesSignal) — jamais de signal sans source consultable.
 */
export const crmSalesSignalRouter = Router();

// Mêmes libellés que SIGNAL_TYPE_LABELS côté client (public/crm.html) — pour
// que le texte de detectedProject corresponde exactement à ce que l'écran
// affiche déjà pour ce signal.
const SIGNAL_TYPE_LABELS: Record<string, string> = {
  actualite: "Actualité",
  linkedin_post: "Post LinkedIn",
  ouverture: "Ouverture",
  renovation: "Rénovation",
  recrutement: "Recrutement",
  changement_pms: "Changement de PMS",
  agrandissement: "Agrandissement",
  autre: "Autre",
};

/**
 * Projet détecté (CrmProspect.detectedProject/detectedProjectDate) —
 * dérivé du signal d'achat le plus pertinent une fois VÉRIFIÉ (status
 * "fact"), jamais d'un simple "to_verify"/"hypothesis" (§2 du brief :
 * "ne jamais présenter une donnée non vérifiée comme un fait"). Le signal
 * le plus RÉCENT (date de publication, sinon de vérification) l'emporte —
 * un projet détecté plus tôt mais plus ancien ne doit pas rester affiché
 * si un signal plus récent vient le contredire ou le préciser.
 */
async function syncDetectedProject(signal: { prospectId: string | null; status: string; signalType: string; hypothesis: string | null; publishedAt: Date | null; verifiedAt: Date | null }) {
  if (!signal.prospectId || signal.status !== "fact") return;
  const candidateDate = signal.publishedAt || signal.verifiedAt || new Date();
  const prospect = await prisma.crmProspect.findUnique({ where: { id: signal.prospectId }, select: { detectedProjectDate: true } });
  if (!prospect) return;
  if (prospect.detectedProjectDate && prospect.detectedProjectDate >= candidateDate) return;
  const label = SIGNAL_TYPE_LABELS[signal.signalType] || signal.signalType;
  await prisma.crmProspect.update({
    where: { id: signal.prospectId },
    data: {
      detectedProject: signal.hypothesis ? `${label} — ${signal.hypothesis}` : label,
      detectedProjectDate: candidateDate,
    },
  });
}

crmSalesSignalRouter.get(
  "/crmSalesSignal/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const prospectId = String(req.query.prospectId || "");
    if (!prospectId) throw new HttpError(400, "prospectId requis");
    const rows = await prisma.salesSignal.findMany({ where: { prospectId }, orderBy: { createdAt: "desc" } });
    res.json(rows);
  })
);

interface CreateBody {
  prospectId: string;
  companyName?: string;
  source?: string;
  url: string;
  signalType: string;
  publishedAt?: string;
  hypothesis?: string;
  status?: string;
}

crmSalesSignalRouter.post(
  "/crmSalesSignal/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as CreateBody;
    if (!b.prospectId) throw new HttpError(400, "prospectId requis");
    if (!b.url || !b.url.trim()) throw new HttpError(400, "L'URL source est obligatoire — un signal doit toujours être vérifiable");
    if (!b.signalType) throw new HttpError(400, "signalType requis");
    const prospect = await prisma.crmProspect.findUnique({ where: { id: b.prospectId }, select: { nom: true } });
    if (!prospect) throw new HttpError(404, "Prospect introuvable");
    // Ajouté à la main par un commercial qui a vu l'info lui-même (ex. post
    // LinkedIn via Sales Navigator) — considéré vérifié par défaut,
    // contrairement à un signal généré par l'agent IA (to_verify par défaut).
    const status = b.status || "fact";
    const row = await prisma.salesSignal.create({
      data: {
        prospectId: b.prospectId,
        companyName: b.companyName?.trim() || prospect.nom,
        source: b.source?.trim() || "Ajout manuel",
        url: b.url.trim(),
        signalType: b.signalType,
        publishedAt: b.publishedAt ? new Date(b.publishedAt) : undefined,
        hypothesis: b.hypothesis?.trim() || undefined,
        status,
        verifiedAt: status === "fact" ? new Date() : undefined,
      },
    });
    await syncDetectedProject(row);
    res.status(201).json(row);
  })
);

crmSalesSignalRouter.post(
  "/crmSalesSignal/updateStatus",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const { id, status } = req.body as { id: string; status: string };
    if (!id || !status) throw new HttpError(400, "id et status requis");
    const row = await prisma.salesSignal.update({
      where: { id },
      data: { status, verifiedAt: status === "fact" ? new Date() : undefined },
    });
    await syncDetectedProject(row);
    res.json(row);
  })
);

crmSalesSignalRouter.post(
  "/crmSalesSignal/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const { id } = req.body as { id: string };
    if (!id) throw new HttpError(400, "id requis");
    await prisma.salesSignal.delete({ where: { id } });
    res.json({ ok: true });
  })
);
