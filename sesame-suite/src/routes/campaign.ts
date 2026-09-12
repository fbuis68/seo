import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { resolveScope } from "../lib/scope";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import { countCrmAudience, countHotelAudience, CrmAudienceFilter, HotelAudienceFilter } from "../lib/campaignAudience";
import { processDueCampaign } from "../lib/campaignScheduler";
import { isChannel } from "../lib/messageTemplate";

export const campaignRouter = Router();

function shapeCampaign(c: {
  id: string;
  channel: string;
  name: string;
  templateKey: string | null;
  subject: string | null;
  audienceDesc: string | null;
  audienceSize: number;
  status: string;
  scheduledAt: Date | null;
  sentAt: Date | null;
  successCount: number;
  failureCount: number;
  lastError: string | null;
  createdAt: Date;
}) {
  return {
    id: c.id,
    channel: c.channel,
    name: c.name || "",
    templateKey: c.templateKey || "",
    subject: c.subject || "",
    audienceDesc: c.audienceDesc || "",
    audienceSize: c.audienceSize,
    status: c.status,
    scheduledAt: c.scheduledAt ? c.scheduledAt.toISOString() : null,
    sentAt: c.sentAt ? c.sentAt.toISOString() : null,
    successCount: c.successCount,
    failureCount: c.failureCount,
    lastError: c.lastError || "",
    createdAt: c.createdAt.toISOString(),
  };
}

/** GET /wa/campaign/list?scope=crm — historique + campagnes programmées, les deux portées. */
campaignRouter.get(
  "/campaign/list",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const campaigns = await prisma.campaign.findMany({ where: { entityId }, orderBy: { createdAt: "desc" } });
    res.json(campaigns.map(shapeCampaign));
  })
);

interface AudienceBody {
  filterJson?: CrmAudienceFilter | HotelAudienceFilter;
  manualSelectionIds?: string[];
}

/** POST /wa/campaign/previewAudience — compte les destinataires d'un filtre avant de programmer l'envoi. */
campaignRouter.post(
  "/campaign/previewAudience",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as AudienceBody;
    const count = entityId
      ? await countHotelAudience(entityId, (b.filterJson as HotelAudienceFilter) || null, b.manualSelectionIds || null)
      : await countCrmAudience((b.filterJson as CrmAudienceFilter) || null);
    res.json({ count });
  })
);

interface CreateBody extends AudienceBody {
  name?: string;
  channel: string;
  templateKey: string;
  subject?: string;
  audienceDesc?: string;
  scheduledAt?: string; // ISO — absent/passé = envoi immédiat
}

/**
 * POST /wa/campaign/create — programme (ou déclenche immédiatement si
 * `scheduledAt` est absent/déjà passé) l'envoi réel d'un modèle existant à
 * l'audience décrite par `filterJson`/`manualSelectionIds`. L'envoi
 * lui-même est fait par lib/campaignScheduler.ts (balayage périodique, ou
 * immédiatement après création pour un envoi "maintenant" — cf.
 * processDueCampaign appelé juste après).
 */
campaignRouter.post(
  "/campaign/create",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as CreateBody;
    if (!isChannel(b.channel)) throw new HttpError(400, "channel doit être email, sms ou whatsapp");
    if (!b.templateKey || !b.templateKey.trim()) throw new HttpError(400, "Modèle requis");

    const template = await prisma.messageTemplate.findFirst({
      where: { entityId, channel: b.channel, key: b.templateKey.trim().toLowerCase() },
    });
    if (!template) throw new HttpError(404, "Modèle introuvable pour ce canal");

    const scheduledAt = b.scheduledAt ? new Date(b.scheduledAt) : new Date();
    if (Number.isNaN(scheduledAt.getTime())) throw new HttpError(400, "Date/heure de programmation invalide");
    const isFuture = scheduledAt.getTime() > Date.now() + 60_000; // marge d'une minute pour ne pas dépendre d'un aller-retour réseau

    const campaign = await prisma.campaign.create({
      data: {
        entityId,
        name: (b.name || template.name).trim(),
        channel: b.channel,
        templateKey: template.key,
        subject: template.subject || null,
        audienceDesc: b.audienceDesc || null,
        filterJson: (b.filterJson as Prisma.InputJsonValue) || undefined,
        manualSelectionIds: b.manualSelectionIds && b.manualSelectionIds.length ? (b.manualSelectionIds as Prisma.InputJsonValue) : undefined,
        scheduledAt,
        status: "scheduled",
      },
    });

    if (!isFuture) {
      // Envoi "maintenant" — on ne fait pas attendre l'utilisateur jusqu'au
      // prochain tick du balayage (60s max, mais autant répondre une fois
      // l'envoi réellement fait).
      await processDueCampaign(campaign.id);
    }

    const fresh = await prisma.campaign.findUnique({ where: { id: campaign.id } });
    res.status(201).json(shapeCampaign(fresh!));
  })
);

/** POST /wa/campaign/cancel — body: { id } — seules les campagnes non encore parties peuvent être annulées. */
campaignRouter.post(
  "/campaign/cancel",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const id = (req.body.id as string) || "";
    const campaign = await prisma.campaign.findFirst({ where: { id, entityId } });
    if (!campaign) throw new HttpError(404, "Campagne introuvable");
    if (campaign.status !== "scheduled") throw new HttpError(400, "Cette campagne a déjà été traitée, elle ne peut plus être annulée");
    const updated = await prisma.campaign.update({ where: { id }, data: { status: "cancelled" } });
    res.json(shapeCampaign(updated));
  })
);

/** POST /wa/campaign/delete — body: { id } */
campaignRouter.post(
  "/campaign/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const id = (req.body.id as string) || "";
    const campaign = await prisma.campaign.findFirst({ where: { id, entityId } });
    if (!campaign) throw new HttpError(404, "Campagne introuvable");
    await prisma.campaign.delete({ where: { id } });
    res.json({ ok: true });
  })
);
