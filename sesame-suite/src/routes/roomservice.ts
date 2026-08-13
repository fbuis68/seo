import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";

export const roomserviceRouter = Router();

function shapeProduct(p: {
  id: string;
  category: string;
  label: string;
  description: string | null;
  price: number;
  icon: string | null;
  photo: string | null;
  photos: unknown;
  videoUrl: string | null;
  active: boolean;
  sortOrder: number;
}) {
  return {
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
    sortOrder: p.sortOrder,
  };
}

type CartItem = { id: string; label: string; price: number; qty: number };

function shapeOrder(o: {
  id: string;
  bookingCode: string | null;
  source: string;
  clientName: string | null;
  roomCode: string | null;
  roomName: string | null;
  items: unknown;
  total: number;
  note: string | null;
  status: string;
  createdAt: Date;
}) {
  return {
    id: o.id,
    bookingCode: o.bookingCode || "",
    source: o.source,
    clientName: o.clientName || "Client",
    roomCode: o.roomCode || "",
    roomName: o.roomName || "",
    items: o.items as CartItem[],
    total: o.total,
    note: o.note || "",
    status: o.status,
    createdAt: o.createdAt.toISOString(),
  };
}

/**
 * GET /wa/roomservice/list?entityCode=&bookingCode=
 * Commandes boutique + room-service unifiées (fusionne SCH_ORDERS et
 * SESAME_RS_ORDERS de l'ancien prototype dans une seule table Order).
 */
roomserviceRouter.get(
  "/roomservice/list",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const bookingCode = (req.query.bookingCode as string) || undefined;
    const orders = await prisma.order.findMany({
      where: { entityId: entity.id, ...(bookingCode ? { bookingCode } : {}) },
      orderBy: { createdAt: "desc" },
    });
    res.json(orders.map(shapeOrder));
  })
);

/**
 * POST /wa/roomservice/create
 * Remplace bqPlaceOrder() / rsPlaceOrder() — étape 6 du check-in, onglet
 * Room Service / Boutique de l'espace client, boutique standalone.
 */
roomserviceRouter.post(
  "/roomservice/create",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as {
      bookingCode?: string;
      source: string;
      clientName?: string;
      roomCode?: string;
      roomName?: string;
      items: CartItem[];
      total: number;
      note?: string;
    };
    if (!b.items || !b.items.length) throw new HttpError(400, "Le panier est vide");

    const booking = b.bookingCode
      ? await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code: b.bookingCode } } })
      : null;

    const order = await prisma.order.create({
      data: {
        entityId: entity.id,
        bookingId: booking?.id,
        bookingCode: b.bookingCode || null,
        source: b.source || "roomservice",
        clientName: b.clientName || "Client",
        roomCode: b.roomCode || null,
        roomName: b.roomName || null,
        items: b.items,
        total: b.total || 0,
        note: b.note || null,
        status: "new",
      },
    });

    res.status(201).json(shapeOrder(order));
  })
);

/** POST /wa/roomservice/update — changement de statut (usage back-office). */
roomserviceRouter.post(
  "/roomservice/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const { id, status } = req.body as { id: string; status: string };
    if (!id || !status) throw new HttpError(400, "id et status requis");

    const order = await prisma.order.findFirst({ where: { id, entityId: entity.id } });
    if (!order) throw new HttpError(404, "Commande introuvable");

    const updated = await prisma.order.update({ where: { id }, data: { status } });
    res.json(shapeOrder(updated));
  })
);

// ═══════════════════════════════════════════════ CATALOGUE PRODUITS (admin)
// Panneau back-office "Catalogue produits" — CRUD sur la table Product,
// utilisée aussi bien par le room-service que par la boutique check-in.

/** GET /wa/roomservice/product/list — inclut les produits inactifs (vue admin). */
roomserviceRouter.get(
  "/roomservice/product/list",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const products = await prisma.product.findMany({
      where: { entityId: entity.id },
      orderBy: { sortOrder: "asc" },
    });
    res.json(products.map(shapeProduct));
  })
);

interface ProductBody {
  category: string;
  label: string;
  desc?: string;
  price: number;
  ico?: string;
  photo?: string;
  photos?: string[];
  videoUrl?: string;
  active?: boolean;
  sortOrder?: number;
}

roomserviceRouter.post(
  "/roomservice/product/create",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as ProductBody;
    if (!b.label || !b.category) throw new HttpError(400, "label et category requis");

    const maxOrder = await prisma.product.count({ where: { entityId: entity.id } });
    const product = await prisma.product.create({
      data: {
        entityId: entity.id,
        category: b.category,
        label: b.label,
        description: b.desc || null,
        price: b.price || 0,
        icon: b.ico || null,
        photo: b.photo || null,
        photos: b.photos || (b.photo ? [b.photo] : []),
        videoUrl: b.videoUrl || null,
        active: b.active !== false,
        sortOrder: b.sortOrder ?? maxOrder,
      },
    });
    res.status(201).json(shapeProduct(product));
  })
);

roomserviceRouter.post(
  "/roomservice/product/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const { id, ...b } = req.body as ProductBody & { id: string };
    if (!id) throw new HttpError(400, "id requis");

    const product = await prisma.product.findFirst({ where: { id, entityId: entity.id } });
    if (!product) throw new HttpError(404, "Produit introuvable");

    const updated = await prisma.product.update({
      where: { id },
      data: {
        category: b.category,
        label: b.label,
        description: b.desc,
        price: b.price,
        icon: b.ico,
        photo: b.photo,
        photos: b.photos,
        videoUrl: b.videoUrl,
        active: b.active,
        sortOrder: b.sortOrder,
      },
    });
    res.json(shapeProduct(updated));
  })
);

roomserviceRouter.post(
  "/roomservice/product/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const id = (req.body.id as string) || "";
    const product = await prisma.product.findFirst({ where: { id, entityId: entity.id } });
    if (!product) throw new HttpError(404, "Produit introuvable");
    await prisma.product.delete({ where: { id } });
    res.json({ ok: true });
  })
);
