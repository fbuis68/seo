import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import { createCheckoutSession, PaymentError } from "../lib/payment";
import { listAvailableRooms, quoteBooking, BookingDraft, OCCUPANT_AGE_CATEGORIES } from "../lib/bookingEngine";

export const bookingEngineRouter = Router();

/** GET /wa/bookingEngine/config — réglages du module pour cet établissement (créés vides au besoin). */
bookingEngineRouter.get(
  "/bookingEngine/config",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const config = await prisma.bookingEngineConfig.upsert({
      where: { entityId: entity.id },
      update: {},
      create: { entityId: entity.id },
    });
    res.json({ enabled: config.enabled });
  })
);

/** POST /wa/bookingEngine/config/update */
bookingEngineRouter.post(
  "/bookingEngine/config/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const enabled = !!req.body.enabled;
    const config = await prisma.bookingEngineConfig.upsert({
      where: { entityId: entity.id },
      update: { enabled },
      create: { entityId: entity.id, enabled },
    });
    res.json({ enabled: config.enabled });
  })
);

/** GET /wa/bookingEngine/status?entityCode= — public, permet à la page de réservation de savoir si le module est activé, sans exposer la config. Le paiement en ligne (obligatoire pour réserver) doit lui aussi être configuré. */
bookingEngineRouter.get(
  "/bookingEngine/status",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const [engineConfig, paymentConfig] = await Promise.all([
      prisma.bookingEngineConfig.findUnique({ where: { entityId: entity.id } }),
      prisma.paymentConfig.findUnique({ where: { entityId: entity.id } }),
    ]);
    const enabled = !!engineConfig?.enabled && !!paymentConfig?.enabled && !!paymentConfig.secretKey;
    res.json({ enabled });
  })
);

async function requireEnabled(entityId: string) {
  const [engineConfig, paymentConfig] = await Promise.all([
    prisma.bookingEngineConfig.findUnique({ where: { entityId } }),
    prisma.paymentConfig.findUnique({ where: { entityId } }),
  ]);
  if (!engineConfig?.enabled || !paymentConfig?.enabled || !paymentConfig.secretKey) {
    throw new HttpError(400, "Réservation en ligne non disponible pour cet établissement");
  }
  return paymentConfig;
}

/** GET /wa/bookingEngine/availability?entityCode=&start=&end= — public, chambres disponibles sur la période avec prix. */
bookingEngineRouter.get(
  "/bookingEngine/availability",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    await requireEnabled(entity.id);
    const start = new Date(req.query.start as string);
    const end = new Date(req.query.end as string);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
      throw new HttpError(400, "Dates invalides");
    }
    const rooms = await listAvailableRooms(entity.id, start, end);
    res.json({ rooms });
  })
);

interface CheckoutBody {
  roomId: string;
  startDate: string;
  endDate: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  occupants: Record<string, number>;
  successUrl: string;
  cancelUrl: string;
}

/**
 * POST /wa/bookingEngine/checkout — public. Crée un Order "bookingEngine"
 * (avec le brouillon de réservation dans bookingDraft, statut de paiement
 * "pending") et une session Stripe Checkout pour le montant total (chambre +
 * taxe de séjour). La Booking elle-même n'est créée qu'à la confirmation du
 * paiement (cf. lib/bookingEngine.ts createBookingFromPaidOrder, appelée
 * depuis le webhook dans routes/payment.ts) — jamais ici, pour ne jamais
 * bloquer la chambre sur un panier abandonné.
 */
bookingEngineRouter.post(
  "/bookingEngine/checkout",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const paymentConfig = await requireEnabled(entity.id);

    const b = req.body as CheckoutBody;
    if (!b.roomId) throw new HttpError(400, "Chambre requise");
    if (!b.firstName?.trim() || !b.lastName?.trim()) throw new HttpError(400, "Nom et prénom requis");
    if (!b.email?.trim() || !b.email.includes("@")) throw new HttpError(400, "Email valide requis");
    if (!b.successUrl || !b.cancelUrl) throw new HttpError(400, "successUrl et cancelUrl requis");
    const occupants: Record<string, number> = {};
    for (const cat of OCCUPANT_AGE_CATEGORIES) {
      const n = Math.max(0, Math.floor(Number(b.occupants?.[cat]) || 0));
      if (n) occupants[cat] = n;
    }
    if (!Object.values(occupants).reduce((s, n) => s + n, 0)) throw new HttpError(400, "Au moins un occupant requis");

    const draft: BookingDraft = {
      roomId: b.roomId,
      startDate: b.startDate,
      endDate: b.endDate,
      firstName: b.firstName.trim(),
      lastName: b.lastName.trim(),
      email: b.email.trim().toLowerCase(),
      phone: b.phone?.trim() || undefined,
      occupants,
    };

    let quote;
    try {
      quote = await quoteBooking(entity.id, draft);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "Réservation impossible");
    }

    const order = await prisma.order.create({
      data: {
        entityId: entity.id,
        source: "bookingEngine",
        clientName: `${draft.firstName} ${draft.lastName}`,
        roomCode: quote.room.code,
        roomName: quote.room.name,
        items: [
          { id: "room", label: `${quote.room.name} — ${quote.room.nights} nuit${quote.room.nights > 1 ? "s" : ""}`, price: quote.room.roomTotal, qty: 1 },
          ...(quote.taxeSejour ? [{ id: "taxe-sejour", label: quote.taxeSejour.label, price: quote.taxeSejour.amount, qty: 1 }] : []),
        ],
        total: quote.total,
        bookingDraft: draft as unknown as object,
        status: "new",
        paymentStatus: "pending",
      },
    });

    try {
      const session = await createCheckoutSession(paymentConfig, {
        orderId: order.id,
        items: [
          { label: `${quote.room.name} — ${quote.room.nights} nuit${quote.room.nights > 1 ? "s" : ""}`, unitAmount: Math.round(quote.room.roomTotal * 100), qty: 1 },
          ...(quote.taxeSejour ? [{ label: quote.taxeSejour.label, unitAmount: Math.round(quote.taxeSejour.amount * 100), qty: 1 }] : []),
        ],
        successUrl: b.successUrl,
        cancelUrl: b.cancelUrl,
        customerEmail: draft.email,
      });
      await prisma.order.update({ where: { id: order.id }, data: { stripeSessionId: session.id } });
      res.status(201).json({ checkoutUrl: session.url, orderId: order.id });
    } catch (e) {
      const message = e instanceof PaymentError ? e.message : "Erreur Stripe";
      await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: "failed" } });
      throw new HttpError(400, message);
    }
  })
);
