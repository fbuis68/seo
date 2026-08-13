import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";

export const campaignRouter = Router();

function shapeCampaign(c: {
  id: string;
  channel: string;
  templateKey: string | null;
  subject: string | null;
  content: string | null;
  audienceDesc: string | null;
  audienceSize: number;
  status: string;
  createdAt: Date;
}) {
  return {
    id: c.id,
    channel: c.channel,
    templateKey: c.templateKey || "",
    subject: c.subject || "",
    content: c.content || "",
    audienceDesc: c.audienceDesc || "",
    audienceSize: c.audienceSize,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
  };
}

/** GET /wa/campaign/list — historique des campagnes (panneau "Actions marketing"). */
campaignRouter.get(
  "/campaign/list",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const campaigns = await prisma.campaign.findMany({ where: { entityId: entity.id }, orderBy: { createdAt: "desc" } });
    res.json(campaigns.map(shapeCampaign));
  })
);

/**
 * POST /wa/campaign/create
 * L'audience (segment + effectif) est calculée côté client depuis
 * GET /wa/crm/clients, puis transmise ici pour être journalisée — pas
 * d'envoi réel d'email/SMS dans cette itération (simulation, comme
 * l'ancien prototype).
 */
campaignRouter.post(
  "/campaign/create",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as {
      channel: string;
      templateKey?: string;
      subject?: string;
      content?: string;
      audienceDesc?: string;
      audienceSize?: number;
    };
    if (!b.channel) throw new HttpError(400, "channel requis");

    const campaign = await prisma.campaign.create({
      data: {
        entityId: entity.id,
        channel: b.channel,
        templateKey: b.templateKey || null,
        subject: b.subject || null,
        content: b.content || null,
        audienceDesc: b.audienceDesc || null,
        audienceSize: b.audienceSize || 0,
        status: "sent",
      },
    });
    res.status(201).json(shapeCampaign(campaign));
  })
);

/** POST /wa/campaign/delete — body: { id } */
campaignRouter.post(
  "/campaign/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const id = (req.body.id as string) || "";
    const campaign = await prisma.campaign.findFirst({ where: { id, entityId: entity.id } });
    if (!campaign) throw new HttpError(404, "Campagne introuvable");
    await prisma.campaign.delete({ where: { id } });
    res.json({ ok: true });
  })
);
