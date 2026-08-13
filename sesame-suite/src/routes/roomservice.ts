import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";

export const roomserviceRouter = Router();

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
