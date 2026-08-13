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

// Champs "fidélité" et "éco" pouvant être centralisés au niveau d'un Group
// (cf. panneau "Groupes", Sesame uniquement) — cf. GROUP_ECO_FIELDS ci-dessous
// pour le sous-ensemble éco exact.
const LOYALTY_FIELDS = ["gains", "loyaltyTiers"] as const;
const GROUP_ECO_FIELDS = ["eauMenage", "eauServ", "co2Factor", "freqOpts", "exoEnf", "reducAdos", "exoHand"] as const;

/**
 * GET /wa/entityModuleConfig/list?entityCode=E00000001
 *
 * Retourne le bundle de configuration complet consommé par le front (CFG) :
 * charte graphique, tarifs, modules actifs, catalogue boutique, chambres…
 * Remplace la lecture localStorage('SESAME_CFG') de l'ancien prototype.
 *
 * Si l'établissement appartient à un Group avec une politique centralisée
 * (fidélité et/ou éco), les champs correspondants sont remplacés par les
 * valeurs partagées du groupe — cf. panneau "Groupes".
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

    const group = entity.groupId ? await prisma.group.findUnique({ where: { id: entity.groupId } }) : null;
    const loyaltyCentralized = group?.loyaltyMode === "centralized";
    const ecoCentralized = group?.ecoMode === "centralized";
    const sharedEco = (group?.sharedEco as Record<string, unknown> | null) || {};

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
      exoEnf: ecoCentralized && sharedEco.exoEnf !== undefined ? sharedEco.exoEnf : cfg.exoEnf,
      reducAdos: ecoCentralized && sharedEco.reducAdos !== undefined ? sharedEco.reducAdos : cfg.reducAdos,
      exoHand: ecoCentralized && sharedEco.exoHand !== undefined ? sharedEco.exoHand : cfg.exoHand,
      eauMenage: ecoCentralized && sharedEco.eauMenage !== undefined ? sharedEco.eauMenage : cfg.eauMenage,
      eauServ: ecoCentralized && sharedEco.eauServ !== undefined ? sharedEco.eauServ : cfg.eauServ,
      co2Factor: ecoCentralized && sharedEco.co2Factor !== undefined ? sharedEco.co2Factor : cfg.co2Factor,
      freqOpts: ecoCentralized && sharedEco.freqOpts !== undefined ? sharedEco.freqOpts : cfg.freqOpts,
      gains: loyaltyCentralized && group?.sharedGains ? group.sharedGains : cfg.gains,
      checkinModules: cfg.checkinModules,
      rewardCatalog: cfg.rewardCatalog,
      loyaltyTiers: loyaltyCentralized && group?.sharedLoyaltyTiers ? group.sharedLoyaltyTiers : cfg.loyaltyTiers,
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
      groupPolicy: group
        ? { groupCode: group.code, groupName: group.name, loyaltyCentralized, ecoCentralized }
        : null,
    });
  })
);

/**
 * POST /wa/entityModuleConfig/update
 * Écrit un sous-ensemble de champs de la config (charte, textes, tarifs,
 * gains, modules actifs, catalogues JSON…) — remplace saveCfg() en
 * localStorage. Protégé (back-office uniquement).
 *
 * Les panneaux du front envoient systématiquement le bundle CFG complet
 * (cf. saveCfg()), y compris les champs fidélité/éco même quand ils
 * n'ont pas été modifiés — si l'établissement appartient à un groupe à
 * politique centralisée, ces champs sont donc silencieusement ignorés ici
 * (seul le panneau "Groupes", Sesame uniquement, peut les modifier).
 */
configRouter.post(
  "/entityModuleConfig/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const group = entity.groupId ? await prisma.group.findUnique({ where: { id: entity.groupId } }) : null;

    const data: Record<string, unknown> = {};
    for (const field of UPDATABLE_FIELDS) {
      if (req.body[field] !== undefined) data[field] = req.body[field];
    }
    if (group?.loyaltyMode === "centralized") {
      for (const field of LOYALTY_FIELDS) delete data[field];
    }
    if (group?.ecoMode === "centralized") {
      for (const field of GROUP_ECO_FIELDS) delete data[field];
    }

    const updated = await prisma.entityModuleConfig.update({
      where: { entityId: entity.id },
      data,
    });
    res.json({ ok: true, updatedAt: updated.updatedAt });
  })
);
