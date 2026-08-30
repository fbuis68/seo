import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import type { Vendor } from "@prisma/client";

// Points de vente partenaires de la boutique — cf. schema.prisma Vendor /
// VendorCommission. Deux surfaces dans ce fichier :
//  - Panneau admin (requireAdmin) : créer un point de vente (génère le lien
//    d'invitation), l'activer/suspendre, ajuster le taux de commission,
//    consulter et régler le relevé de commissions.
//  - Portail partenaire, public mais authentifié par jeton (portalToken) —
//    pas de mot de passe, le lien fait office d'identifiant. Le partenaire y
//    complète son profil et gère lui-même son catalogue en libre-service
//    (cf. public/vendor-portal.html).

export const vendorRouter = Router();

function shapeVendor(v: Vendor) {
  return {
    id: v.id,
    name: v.name,
    description: v.description || "",
    contactName: v.contactName || "",
    contactEmail: v.contactEmail || "",
    contactPhone: v.contactPhone || "",
    status: v.status,
    commissionPct: v.commissionPct,
    portalToken: v.portalToken,
    createdAt: v.createdAt.toISOString(),
  };
}

async function commissionTotals(vendorId: string) {
  const [due, settled] = await Promise.all([
    prisma.vendorCommission.aggregate({ where: { vendorId, status: "due" }, _sum: { commissionAmount: true, salesAmount: true } }),
    prisma.vendorCommission.aggregate({ where: { vendorId, status: "settled" }, _sum: { commissionAmount: true } }),
  ]);
  return {
    salesDue: due._sum.salesAmount || 0,
    commissionDue: due._sum.commissionAmount || 0,
    commissionSettled: settled._sum.commissionAmount || 0,
  };
}

// ═══════════════════════════════════════════════ ADMIN — CRUD points de vente

/** GET /wa/vendor/list — points de vente de l'hôtel, avec relevé de commission résumé. */
vendorRouter.get(
  "/vendor/list",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const vendors = await prisma.vendor.findMany({ where: { entityId: entity.id }, orderBy: { createdAt: "desc" } });
    const shaped = await Promise.all(
      vendors.map(async (v) => ({ ...shapeVendor(v), ...(await commissionTotals(v.id)) }))
    );
    res.json(shaped);
  })
);

interface VendorBody {
  name?: string;
  description?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  commissionPct?: number;
  status?: string;
}

/** POST /wa/vendor/create — crée un point de vente "pending" et son lien d'invitation permanent. */
vendorRouter.post(
  "/vendor/create",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as VendorBody;
    const name = (b.name || "").trim();
    if (!name) throw new HttpError(400, "Nom du point de vente requis");
    const vendor = await prisma.vendor.create({
      data: {
        entityId: entity.id,
        name,
        description: b.description || null,
        contactName: b.contactName || null,
        contactEmail: b.contactEmail || null,
        contactPhone: b.contactPhone || null,
        commissionPct: b.commissionPct != null ? b.commissionPct : undefined,
      },
    });
    res.status(201).json({ ...shapeVendor(vendor), salesDue: 0, commissionDue: 0, commissionSettled: 0 });
  })
);

/** POST /wa/vendor/update — modifie un point de vente (y compris son statut : activer/suspendre). */
vendorRouter.post(
  "/vendor/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const { id, ...b } = req.body as VendorBody & { id: string };
    if (!id) throw new HttpError(400, "id requis");
    const vendor = await prisma.vendor.findFirst({ where: { id, entityId: entity.id } });
    if (!vendor) throw new HttpError(404, "Point de vente introuvable");
    const updated = await prisma.vendor.update({
      where: { id },
      data: {
        name: b.name?.trim() || undefined,
        description: b.description,
        contactName: b.contactName,
        contactEmail: b.contactEmail,
        contactPhone: b.contactPhone,
        commissionPct: b.commissionPct,
        status: b.status,
      },
    });
    res.json({ ...shapeVendor(updated), ...(await commissionTotals(updated.id)) });
  })
);

/** GET /wa/vendor/commissions?vendorId= — relevé détaillé (due + réglées) d'un point de vente. */
vendorRouter.get(
  "/vendor/commissions",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const vendorId = (req.query.vendorId as string) || "";
    const vendor = await prisma.vendor.findFirst({ where: { id: vendorId, entityId: entity.id } });
    if (!vendor) throw new HttpError(404, "Point de vente introuvable");
    const rows = await prisma.vendorCommission.findMany({ where: { vendorId }, orderBy: { createdAt: "desc" }, take: 200 });
    res.json(
      rows.map((r) => ({
        id: r.id,
        orderId: r.orderId,
        salesAmount: r.salesAmount,
        commissionPct: r.commissionPct,
        commissionAmount: r.commissionAmount,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        settledAt: r.settledAt ? r.settledAt.toISOString() : null,
      }))
    );
  })
);

/** POST /wa/vendor/commission/settle — marque comme réglées toutes les commissions dues d'un point de vente (règlement effectué hors application). */
vendorRouter.post(
  "/vendor/commission/settle",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const vendorId = (req.body.vendorId as string) || "";
    const vendor = await prisma.vendor.findFirst({ where: { id: vendorId, entityId: entity.id } });
    if (!vendor) throw new HttpError(404, "Point de vente introuvable");
    const result = await prisma.vendorCommission.updateMany({
      where: { vendorId, status: "due" },
      data: { status: "settled", settledAt: new Date() },
    });
    res.json({ settledCount: result.count, ...(await commissionTotals(vendorId)) });
  })
);

// ═══════════════════════════════════════════════ PORTAIL PARTENAIRE (public, jeton)
// Aucune de ces routes n'utilise requireAdmin/resolveEntity — le partenaire
// n'a ni compte admin ni entityCode, uniquement le jeton reçu dans son lien
// d'invitation. Toute action est strictement cantonnée au Vendor propriétaire
// du jeton (jamais un id fourni par le client sans vérification de
// propriété), pour qu'un partenaire ne puisse jamais lire/modifier les
// données d'un autre point de vente ou de l'hôtel lui-même.

async function vendorByToken(token: string | undefined) {
  if (!token) throw new HttpError(400, "Lien invalide");
  const vendor = await prisma.vendor.findUnique({ where: { portalToken: token } });
  if (!vendor) throw new HttpError(404, "Lien invalide ou expiré");
  return vendor;
}

/** GET /wa/vendor/portal?token= — profil du point de vente + nom de l'hôtel, pour l'accueil du portail. */
vendorRouter.get(
  "/vendor/portal",
  asyncHandler(async (req, res) => {
    const vendor = await vendorByToken(req.query.token as string | undefined);
    const entity = await prisma.entity.findUnique({ where: { id: vendor.entityId } });
    res.json({ ...shapeVendor(vendor), hotelName: entity?.name || "" });
  })
);

/**
 * POST /wa/vendor/portal/profile — le partenaire complète/modifie son
 * profil. Premier envoi alors que status="pending" -> passe automatiquement
 * "active" (libre-service, pas de validation manuelle par l'hôtel en v1) :
 * l'hôtel garde la main pour suspendre ensuite si besoin (cf. /vendor/update).
 */
vendorRouter.post(
  "/vendor/portal/profile",
  asyncHandler(async (req, res) => {
    const b = req.body as VendorBody & { token?: string };
    const vendor = await vendorByToken(b.token);
    const name = (b.name || "").trim();
    if (!name) throw new HttpError(400, "Nom du point de vente requis");
    const updated = await prisma.vendor.update({
      where: { id: vendor.id },
      data: {
        name,
        description: b.description,
        contactName: b.contactName,
        contactEmail: b.contactEmail,
        contactPhone: b.contactPhone,
        status: vendor.status === "pending" ? "active" : undefined,
      },
    });
    res.json(shapeVendor(updated));
  })
);

function shapePortalProduct(p: { id: string; category: string; label: string; description: string | null; price: number; icon: string | null; active: boolean }) {
  return { id: p.id, cat: p.category, label: p.label, desc: p.description || "", price: p.price, ico: p.icon || "ti-shopping-bag", active: p.active };
}

/** GET /wa/vendor/portal/products?token= — catalogue du partenaire (actifs + inactifs). */
vendorRouter.get(
  "/vendor/portal/products",
  asyncHandler(async (req, res) => {
    const vendor = await vendorByToken(req.query.token as string | undefined);
    const products = await prisma.product.findMany({ where: { vendorId: vendor.id }, orderBy: { sortOrder: "asc" } });
    res.json(products.map(shapePortalProduct));
  })
);

interface PortalProductBody {
  token?: string;
  id?: string;
  category?: string;
  label?: string;
  desc?: string;
  price?: number;
  ico?: string;
  active?: boolean;
}

/** POST /wa/vendor/portal/products/create?token= — le partenaire ajoute un produit à son propre point de vente. */
vendorRouter.post(
  "/vendor/portal/products/create",
  asyncHandler(async (req, res) => {
    const b = req.body as PortalProductBody;
    const vendor = await vendorByToken(b.token);
    if (!b.label || !b.category) throw new HttpError(400, "label et category requis");
    const maxOrder = await prisma.product.count({ where: { vendorId: vendor.id } });
    const product = await prisma.product.create({
      data: {
        entityId: vendor.entityId,
        vendorId: vendor.id,
        category: b.category,
        label: b.label,
        description: b.desc || null,
        price: b.price || 0,
        icon: b.ico || null,
        active: b.active !== false,
        sortOrder: maxOrder,
      },
    });
    res.status(201).json(shapePortalProduct(product));
  })
);

/** POST /wa/vendor/portal/products/update — modification limitée aux produits appartenant au point de vente du jeton. */
vendorRouter.post(
  "/vendor/portal/products/update",
  asyncHandler(async (req, res) => {
    const b = req.body as PortalProductBody;
    const vendor = await vendorByToken(b.token);
    if (!b.id) throw new HttpError(400, "id requis");
    const product = await prisma.product.findFirst({ where: { id: b.id, vendorId: vendor.id } });
    if (!product) throw new HttpError(404, "Produit introuvable");
    const updated = await prisma.product.update({
      where: { id: b.id },
      data: { category: b.category, label: b.label, description: b.desc, price: b.price, icon: b.ico, active: b.active },
    });
    res.json(shapePortalProduct(updated));
  })
);

/** POST /wa/vendor/portal/products/delete — suppression limitée aux produits appartenant au point de vente du jeton. */
vendorRouter.post(
  "/vendor/portal/products/delete",
  asyncHandler(async (req, res) => {
    const b = req.body as PortalProductBody;
    const vendor = await vendorByToken(b.token);
    const product = await prisma.product.findFirst({ where: { id: b.id || "", vendorId: vendor.id } });
    if (!product) throw new HttpError(404, "Produit introuvable");
    await prisma.product.delete({ where: { id: product.id } });
    res.json({ ok: true });
  })
);

/** GET /wa/vendor/portal/sales?token= — relevé de ventes/commissions du partenaire (lecture seule, transparence). */
vendorRouter.get(
  "/vendor/portal/sales",
  asyncHandler(async (req, res) => {
    const vendor = await vendorByToken(req.query.token as string | undefined);
    const totals = await commissionTotals(vendor.id);
    const rows = await prisma.vendorCommission.findMany({ where: { vendorId: vendor.id }, orderBy: { createdAt: "desc" }, take: 100 });
    res.json({
      ...totals,
      commissionPct: vendor.commissionPct,
      recent: rows.map((r) => ({
        salesAmount: r.salesAmount,
        commissionAmount: r.commissionAmount,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  })
);
