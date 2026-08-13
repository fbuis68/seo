import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { normaliseRoom } from "../lib/normalize";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";

export const configRouter = Router();

// Champs de EntityModuleConfig modifiables depuis le back-office (POST /wa/entityModuleConfig/update)
const UPDATABLE_FIELDS = [
  "hotelName",
  "hotelSlogan",
  "hotelAddr",
  "hotelEmail",
  "stars",
  "colors",
  "radius",
  "radiusBtn",
  "shadow",
  "fontTitle",
  "fontBody",
  "darkH",
  "logoMain",
  "logoIcon",
  "msgEco",
  "msgWelcome",
  "btnLabel",
  "ptsLabel",
  "progName",
  "lang",
  "currency",
  "tarifs",
  "exoEnf",
  "reducAdos",
  "exoHand",
  "eauMenage",
  "eauServ",
  "co2Factor",
  "freqOpts",
  "gains",
  "checkinModules",
  "rewardCatalog",
  "loyaltyTiers",
  "hotelPlan",
  "roomTags",
  "accessPoints",
  "kpi",
] as const;

/**
 * GET /wa/entityModuleConfig/list?entityCode=E00000001
 *
 * Retourne le bundle de configuration complet consommé par le front (CFG) :
 * charte graphique, tarifs, modules actifs, catalogue boutique, chambres…
 * Remplace la lecture localStorage('SESAME_CFG') de l'ancien prototype.
 */
configRouter.get(
  "/entityModuleConfig/list",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const cfg = await prisma.entityModuleConfig.findUnique({ where: { entityId: entity.id } });
    if (!cfg) throw new HttpError(404, "Configuration introuvable pour cette entité");

    const rooms = await prisma.room.findMany({ where: { entityId: entity.id }, orderBy: { code: "asc" } });
    const products = await prisma.product.findMany({
      where: { entityId: entity.id, active: true },
      orderBy: { sortOrder: "asc" },
    });

    res.json({
      entityId: entity.code,
      hotelName: cfg.hotelName,
      hotelSlogan: cfg.hotelSlogan || "",
      hotelAddr: cfg.hotelAddr || "",
      hotelEmail: cfg.hotelEmail || "",
      stars: cfg.stars,
      colors: cfg.colors,
      radius: cfg.radius,
      radiusBtn: cfg.radiusBtn,
      shadow: cfg.shadow,
      darkH: cfg.darkH,
      fontTitle: cfg.fontTitle,
      fontBody: cfg.fontBody,
      logoMain: cfg.logoMain,
      logoIcon: cfg.logoIcon,
      msgEco: cfg.msgEco,
      msgWelcome: cfg.msgWelcome,
      btnLabel: cfg.btnLabel,
      ptsLabel: cfg.ptsLabel,
      progName: cfg.progName,
      lang: cfg.lang,
      currency: cfg.currency,
      tarifs: cfg.tarifs,
      exoEnf: cfg.exoEnf,
      reducAdos: cfg.reducAdos,
      exoHand: cfg.exoHand,
      eauMenage: cfg.eauMenage,
      eauServ: cfg.eauServ,
      co2Factor: cfg.co2Factor,
      freqOpts: cfg.freqOpts,
      gains: cfg.gains,
      checkinModules: cfg.checkinModules,
      rewardCatalog: cfg.rewardCatalog,
      loyaltyTiers: cfg.loyaltyTiers,
      hotelPlan: cfg.hotelPlan,
      roomTags: cfg.roomTags,
      accessPoints: cfg.accessPoints,
      kpi: cfg.kpi,
      rooms: rooms.map(normaliseRoom),
      roomServiceCatalog: products.map((p) => ({
        id: p.id,
        cat: p.category,
        label: p.label,
        desc: p.description || "",
        price: p.price,
        ico: p.icon || "ti-shopping-bag",
        photo: p.photo || "",
        photos: (p.photos as string[]) || (p.photo ? [p.photo] : []),
        videoUrl: p.videoUrl || "",
        active: p.active,
      })),
    });
  })
);

/**
 * POST /wa/entityModuleConfig/update
 * Écrit un sous-ensemble de champs de la config (charte, textes, tarifs,
 * gains, modules actifs, catalogues JSON…) — remplace saveCfg() en
 * localStorage. Protégé (back-office uniquement).
 */
configRouter.post(
  "/entityModuleConfig/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const data: Record<string, unknown> = {};
    for (const field of UPDATABLE_FIELDS) {
      if (req.body[field] !== undefined) data[field] = req.body[field];
    }
    const updated = await prisma.entityModuleConfig.update({
      where: { entityId: entity.id },
      data,
    });
    res.json({ ok: true, updatedAt: updated.updatedAt });
  })
);
