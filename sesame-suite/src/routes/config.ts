import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { normaliseRoom } from "../lib/normalize";
import { asyncHandler, HttpError } from "../lib/asyncHandler";

export const configRouter = Router();

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
      stars: cfg.stars,
      colors: cfg.colors,
      radius: cfg.radius,
      radiusBtn: cfg.radiusBtn,
      shadow: cfg.shadow,
      fontTitle: cfg.fontTitle,
      fontBody: cfg.fontBody,
      logoMain: cfg.logoMain,
      msgEco: cfg.msgEco,
      btnLabel: cfg.btnLabel,
      ptsLabel: cfg.ptsLabel,
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
