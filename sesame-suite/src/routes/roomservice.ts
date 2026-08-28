import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import { fireTrigger } from "../lib/automation";
import { reserveLockersForOrder, cancelLockerReservation, LockerReservationItem } from "../lib/lockerSource";

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
  importedFrom: string | null;
  stockQty: number | null;
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
    // Produit importé (ex : Mon Casier Frais) : source du produit et stock
    // disponible au dernier sync — null = produit boutique classique, pas
    // de suivi de stock, toujours affiché quelle que soit la quantité.
    source: p.importedFrom || "",
    stock: p.stockQty,
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
  lockerNumbers: unknown;
  lockerPickupCode: string | null;
  lockerSourceWarning: string | null;
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
    // Réservation de casier Mon Casier Frais associée, si le panier
    // contenait des articles importés — cf. lib/lockerSource.ts. Tableau
    // vide/code vide = pas d'article "casier" dans cette commande.
    lockerNumbers: (o.lockerNumbers as number[]) || [],
    lockerPickupCode: o.lockerPickupCode || "",
    lockerSourceWarning: o.lockerSourceWarning || null,
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

    if (booking) {
      fireTrigger("order.created", {
        entityId: entity.id,
        targetType: "order",
        targetId: order.id,
        recipient: { email: booking.personEmail, phone: booking.personPhone },
        variables: { prenom: booking.personFirstname, nom: booking.personLastname, total: String(order.total) },
      }).catch((e) => console.error("[automation] order.created:", e));
    }

    // Réservation best-effort d'un casier Mon Casier Frais pour les
    // articles importés du panier (cf. lib/lockerSource.ts) — jamais
    // bloquante : la commande locale existe déjà même si cette étape
    // échoue, auquel cas lockerSourceWarning porte le message d'erreur
    // plutôt qu'un faux succès.
    let finalOrder = order;
    const lockerProducts = await prisma.product.findMany({
      where: { id: { in: b.items.map((it) => it.id) }, entityId: entity.id, importedFrom: "moncasierfrais" },
    });
    if (lockerProducts.length) {
      const config = await prisma.lockerSourceConfig.findUnique({ where: { entityId: entity.id } });
      const clientEmail = booking?.personEmail;
      let warning: string | undefined;
      if (!config || !config.enabled) {
        warning = "Connecteur Mon Casier Frais non activé — articles casier non réservés";
      } else if (!clientEmail) {
        warning = "Email client indisponible — réservation de casier non effectuée";
      } else {
        const reservationItems: LockerReservationItem[] = lockerProducts.map((product) => ({
          product,
          qty: b.items.filter((it) => it.id === product.id).reduce((s, it) => s + it.qty, 0),
        }));
        const pickupCode = String(Math.floor(100000 + Math.random() * 900000));
        const result = await reserveLockersForOrder(config, reservationItems, {
          clientEmail,
          pickupCode,
          comments: b.note,
        }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
        if (result.ok) {
          finalOrder = await prisma.order.update({
            where: { id: order.id },
            data: {
              lockerNumbers: result.lockerNumbers || [],
              lockerPickupCode: pickupCode,
              lockerSourceOrderId: result.mcfOrderId || null,
            },
          });
        } else {
          warning = result.error;
        }
      }
      if (warning) {
        finalOrder = await prisma.order.update({ where: { id: order.id }, data: { lockerSourceWarning: warning } });
      }
    }

    res.status(201).json(shapeOrder(finalOrder));
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

    if (status === "delivered" && order.status !== "delivered" && updated.bookingId) {
      const booking = await prisma.booking.findUnique({ where: { id: updated.bookingId } });
      if (booking) {
        fireTrigger("order.delivered", {
          entityId: entity.id,
          targetType: "order",
          targetId: updated.id,
          recipient: { email: booking.personEmail, phone: booking.personPhone },
          variables: { prenom: booking.personFirstname, nom: booking.personLastname, total: String(updated.total) },
        }).catch((e) => console.error("[automation] order.delivered:", e));
      }
    }

    if (status === "cancelled" && order.status !== "cancelled" && updated.bookingId) {
      const booking = await prisma.booking.findUnique({ where: { id: updated.bookingId } });
      if (booking) {
        fireTrigger("order.cancelled", {
          entityId: entity.id,
          targetType: "order",
          targetId: updated.id,
          recipient: { email: booking.personEmail, phone: booking.personPhone },
          variables: { prenom: booking.personFirstname, nom: booking.personLastname, total: String(updated.total) },
        }).catch((e) => console.error("[automation] order.cancelled:", e));
      }
    }

    // Annulation best-effort de la réservation de casier associée, si la
    // commande en avait une — jamais bloquante pour le changement de statut
    // local, un avertissement remplace lockerSourceWarning en cas d'échec.
    let finalUpdated = updated;
    if (status === "cancelled" && order.status !== "cancelled" && updated.lockerSourceOrderId) {
      const config = await prisma.lockerSourceConfig.findUnique({ where: { entityId: entity.id } });
      if (config) {
        const result = await cancelLockerReservation(config, updated.lockerSourceOrderId, "Commande annulée depuis Sesame Suite").catch(
          (e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) })
        );
        if (!result.ok) {
          finalUpdated = await prisma.order.update({ where: { id }, data: { lockerSourceWarning: result.error } });
        }
      }
    }

    res.json(shapeOrder(finalUpdated));
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

/**
 * GET /wa/roomservice/product/public — sans authentification, uniquement les
 * produits actifs. Alimente la boutique du check-in (public/checkin.html) et
 * l'espace client : ces pages n'ont pas de JWT admin et ne pouvaient jusqu'ici
 * jamais lire le vrai catalogue, d'où des prix figés au fallback local.
 */
roomserviceRouter.get(
  "/roomservice/product/public",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    // Mode démo (LockerSourceConfig.showOutOfStock) — affiche et rend
    // commandables côté client les produits importés même en rupture,
    // utile quand le compte Mon Casier Frais connecté est un environnement
    // de développement sans casiers physiquement garnis. N'affecte QUE
    // l'affichage : la réservation à la commande revérifie toujours le
    // stock réel en direct (cf. reserveLockersForOrder) et échoue
    // proprement si rien n'est réellement disponible.
    const lockerConfig = await prisma.lockerSourceConfig.findUnique({ where: { entityId: entity.id } });
    const showOutOfStock = lockerConfig?.showOutOfStock ?? false;
    const products = await prisma.product.findMany({
      where: {
        entityId: entity.id,
        active: true,
        // Masque les produits importés (Mon Casier Frais) en rupture —
        // stockQty=0 au dernier sync. Les produits boutique classiques
        // (stockQty=null, pas de suivi de stock) restent toujours affichés.
        ...(showOutOfStock ? {} : { NOT: { importedFrom: { not: null }, stockQty: 0 } }),
      },
      orderBy: { sortOrder: "asc" },
    });
    const shaped = products.map(shapeProduct);
    if (showOutOfStock) {
      // Masque aussi le compteur de stock côté client (sinon la limite de
      // quantité au panier resterait bloquée à 0) — l'admin garde le vrai
      // stock dans /product/list.
      shaped.forEach((p) => {
        if (p.source === "moncasierfrais") p.stock = null;
      });
    }
    res.json(shaped);
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
