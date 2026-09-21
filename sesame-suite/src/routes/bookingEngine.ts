import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import { createCheckoutSession, createSetupIntentCustomer, createSetupIntent, retrieveSetupIntent, PaymentError } from "../lib/payment";
import { listAvailableRooms, quoteBooking, createBookingDirectUnpaid, BookingDraft, OCCUPANT_AGE_CATEGORIES } from "../lib/bookingEngine";

export const bookingEngineRouter = Router();

const DURATION_UNITS = new Set(["jour", "mois", "an"]);
const MAX_DURATION_OPTIONS = 8;

/**
 * Valide BookingEngineConfig.durationOptions — chaque entrée est {amount,unit}
 * (ex: {amount:3,unit:"jour"}), affichée en bouton sur booking.html pour que
 * le client calcule le départ depuis sa date d'arrivée sans devoir la saisir
 * lui-même. Rejette plutôt que de silencieusement tronquer une entrée
 * invalide — même logique que parseAttachments (routes/messaging.ts).
 */
function parseDurationOptions(raw: unknown): { amount: number; unit: string }[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, "durationOptions doit être un tableau");
  if (raw.length > MAX_DURATION_OPTIONS) throw new HttpError(400, `Maximum ${MAX_DURATION_OPTIONS} durées`);
  return raw.map((o) => {
    const amount = Number((o as { amount?: unknown })?.amount);
    const unit = (o as { unit?: unknown })?.unit;
    if (!Number.isInteger(amount) || amount < 1 || amount > 999) throw new HttpError(400, "Durée invalide (nombre entier entre 1 et 999)");
    if (typeof unit !== "string" || !DURATION_UNITS.has(unit)) throw new HttpError(400, "Unité de durée invalide (jour, mois ou an)");
    return { amount, unit };
  });
}

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
    res.json({
      enabled: config.enabled,
      requirePayment: config.requirePayment,
      durationOptions: config.durationOptions,
      hideRoomSelection: config.hideRoomSelection,
      hideOccupants: config.hideOccupants,
      skipAvailabilityCheck: config.skipAvailabilityCheck,
      cardOnFileMode: config.cardOnFileMode,
    });
  })
);

/** POST /wa/bookingEngine/config/update */
bookingEngineRouter.post(
  "/bookingEngine/config/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const enabled = !!req.body.enabled;
    const requirePayment = req.body.requirePayment !== undefined ? !!req.body.requirePayment : undefined;
    const durationOptions = req.body.durationOptions !== undefined ? parseDurationOptions(req.body.durationOptions) : undefined;
    const hideRoomSelection = req.body.hideRoomSelection !== undefined ? !!req.body.hideRoomSelection : undefined;
    const hideOccupants = req.body.hideOccupants !== undefined ? !!req.body.hideOccupants : undefined;
    const skipAvailabilityCheck = req.body.skipAvailabilityCheck !== undefined ? !!req.body.skipAvailabilityCheck : undefined;
    const cardOnFileMode = req.body.cardOnFileMode !== undefined ? !!req.body.cardOnFileMode : undefined;
    const data = {
      enabled,
      ...(requirePayment !== undefined ? { requirePayment } : {}),
      ...(durationOptions !== undefined ? { durationOptions } : {}),
      ...(hideRoomSelection !== undefined ? { hideRoomSelection } : {}),
      ...(hideOccupants !== undefined ? { hideOccupants } : {}),
      ...(skipAvailabilityCheck !== undefined ? { skipAvailabilityCheck } : {}),
      ...(cardOnFileMode !== undefined ? { cardOnFileMode } : {}),
    };
    const config = await prisma.bookingEngineConfig.upsert({
      where: { entityId: entity.id },
      update: data,
      create: { entityId: entity.id, ...data },
    });
    res.json({
      enabled: config.enabled,
      requirePayment: config.requirePayment,
      durationOptions: config.durationOptions,
      hideRoomSelection: config.hideRoomSelection,
      hideOccupants: config.hideOccupants,
      skipAvailabilityCheck: config.skipAvailabilityCheck,
      cardOnFileMode: config.cardOnFileMode,
    });
  })
);

/**
 * GET /wa/bookingEngine/status?entityCode= — public, permet à la page de
 * réservation de savoir si le module est activé et si le paiement en ligne
 * est obligatoire (requirePayment) ou juste disponible en option
 * (paymentAvailable, module Paiement configuré) — sans exposer la config.
 */
bookingEngineRouter.get(
  "/bookingEngine/status",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const [engineConfig, paymentConfig] = await Promise.all([
      prisma.bookingEngineConfig.findUnique({ where: { entityId: entity.id } }),
      prisma.paymentConfig.findUnique({ where: { entityId: entity.id } }),
    ]);
    const paymentAvailable = !!paymentConfig?.enabled && !!paymentConfig.secretKey;
    const requirePayment = engineConfig?.requirePayment ?? true;
    const cardOnFileMode = !!engineConfig?.cardOnFileMode;
    // Empreinte bancaire : besoin de la clé secrète (appel serveur Stripe)
    // ET de la clé publiable (Stripe.js côté client) — sans passer par le
    // choix requirePayment/paymentAvailable, propre au flux Checkout
    // classique.
    const cardOnFileReady = !!paymentConfig?.secretKey && !!paymentConfig?.publishableKey;
    // Activé seulement si le module l'est, ET si le mode de paiement actif
    // (empreinte bancaire, ou Checkout classique obligatoire/optionnel) est
    // effectivement disponible — un établissement mal configuré reste
    // indisponible plutôt que d'afficher un parcours qui échouera à la fin.
    const enabled = !!engineConfig?.enabled && (cardOnFileMode ? cardOnFileReady : !requirePayment || paymentAvailable);
    const durationOptions = Array.isArray(engineConfig?.durationOptions) ? engineConfig.durationOptions : [];
    res.json({
      enabled,
      requirePayment,
      paymentAvailable,
      durationOptions,
      hideRoomSelection: !!engineConfig?.hideRoomSelection,
      hideOccupants: !!engineConfig?.hideOccupants,
      cardOnFileMode,
      stripePublishableKey: cardOnFileMode && cardOnFileReady ? paymentConfig?.publishableKey : "",
    });
  })
);

/** Le module doit être activé pour cet établissement — condition commune à
 * toutes les routes publiques ci-dessous, indépendamment du paiement. */
async function requireEngineEnabled(entityId: string) {
  const engineConfig = await prisma.bookingEngineConfig.findUnique({ where: { entityId } });
  if (!engineConfig?.enabled) throw new HttpError(400, "Réservation en ligne non disponible pour cet établissement");
  return engineConfig;
}

/** GET /wa/bookingEngine/availability?entityCode=&start=&end= — public, chambres disponibles sur la période avec prix. */
bookingEngineRouter.get(
  "/bookingEngine/availability",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    await requireEngineEnabled(entity.id);
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

function parseOccupants(raw: Record<string, number> | undefined): Record<string, number> {
  const occupants: Record<string, number> = {};
  for (const cat of OCCUPANT_AGE_CATEGORIES) {
    const n = Math.max(0, Math.floor(Number(raw?.[cat]) || 0));
    if (n) occupants[cat] = n;
  }
  return occupants;
}

function parseDraft(b: CheckoutBody): BookingDraft {
  if (!b.roomId) throw new HttpError(400, "Chambre requise");
  if (!b.firstName?.trim() || !b.lastName?.trim()) throw new HttpError(400, "Nom et prénom requis");
  if (!b.email?.trim() || !b.email.includes("@")) throw new HttpError(400, "Email valide requis");
  const occupants = parseOccupants(b.occupants);
  if (!Object.values(occupants).reduce((s, n) => s + n, 0)) throw new HttpError(400, "Au moins un occupant requis");
  return {
    roomId: b.roomId,
    startDate: b.startDate,
    endDate: b.endDate,
    firstName: b.firstName.trim(),
    lastName: b.lastName.trim(),
    email: b.email.trim().toLowerCase(),
    phone: b.phone?.trim() || undefined,
    occupants,
  };
}

/**
 * POST /wa/bookingEngine/checkout — public. Crée un Order "bookingEngine"
 * (avec le brouillon de réservation dans bookingDraft, statut de paiement
 * "pending") et une session Stripe Checkout pour le montant total (chambre +
 * taxe de séjour). La Booking elle-même n'est créée qu'à la confirmation du
 * paiement (cf. lib/bookingEngine.ts createBookingFromPaidOrder, appelée
 * depuis le webhook dans routes/payment.ts) — jamais ici, pour ne jamais
 * bloquer la chambre sur un panier abandonné. Accessible que le paiement
 * soit obligatoire ou simplement proposé en option (cf. /bookDirect pour
 * l'alternative "payer sur place").
 */
bookingEngineRouter.post(
  "/bookingEngine/checkout",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    await requireEngineEnabled(entity.id);
    const paymentConfig = await prisma.paymentConfig.findUnique({ where: { entityId: entity.id } });
    if (!paymentConfig?.enabled || !paymentConfig.secretKey) throw new HttpError(400, "Paiement en ligne non configuré pour cet établissement");

    const b = req.body as CheckoutBody;
    if (!b.successUrl || !b.cancelUrl) throw new HttpError(400, "successUrl et cancelUrl requis");
    const draft = parseDraft(b);

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

/**
 * POST /wa/bookingEngine/bookDirect — public. Réservation "payer sur
 * place" : crée la Booking immédiatement, sans passer par Stripe — refusé
 * si BookingEngineConfig.requirePayment est vrai (le paiement en ligne
 * n'est alors pas optionnel, cf. /checkout).
 */
bookingEngineRouter.post(
  "/bookingEngine/bookDirect",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const engineConfig = await requireEngineEnabled(entity.id);
    if (engineConfig.requirePayment) throw new HttpError(400, "Le paiement en ligne est obligatoire pour réserver auprès de cet établissement");

    const draft = parseDraft(req.body as CheckoutBody);
    try {
      await quoteBooking(entity.id, draft); // valide dates/chambre/disponibilité avant création
      const booking = await createBookingDirectUnpaid(entity, draft, "réservation directe (paiement sur place)");
      res.status(201).json({ code: booking.code });
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "Réservation impossible");
    }
  })
);

interface CardOnFileBody {
  roomId: string;
  startDate: string;
  endDate: string;
  // Contact minimal — téléphone OU email, au choix (BookingEngineConfig.
  // cardOnFileMode simplifie le formulaire par rapport à /checkout et
  // /bookDirect, qui exigent nom+prénom+email).
  contact: string;
  cardholderName?: string;
  occupants?: Record<string, number>;
}

/** Coupe grossièrement un nom complet en prénom/nom — meilleur effort
 * (billing_details.name Stripe ou nom saisi/scanné côté client), jamais
 * bloquant : un contact seul (sans nom) reste accepté. */
function splitCardholderName(name: string | undefined): { firstName: string; lastName: string } {
  const trimmed = (name || "").trim().replace(/\s+/g, " ");
  if (!trimmed) return { firstName: "Client", lastName: "" };
  const parts = trimmed.split(" ");
  return parts.length === 1 ? { firstName: parts[0], lastName: "" } : { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function parseCardOnFileDraft(b: CardOnFileBody): BookingDraft {
  if (!b.roomId) throw new HttpError(400, "Chambre requise");
  const contact = (b.contact || "").trim();
  if (!contact) throw new HttpError(400, "Téléphone ou email requis");
  const isEmail = contact.includes("@");
  if (isEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) throw new HttpError(400, "Email invalide");
  const { firstName, lastName } = splitCardholderName(b.cardholderName);
  const occupants = Object.keys(b.occupants || {}).length ? parseOccupants(b.occupants) : { adulte: 1 };
  return {
    roomId: b.roomId,
    startDate: b.startDate,
    endDate: b.endDate,
    firstName,
    lastName,
    email: isEmail ? contact.toLowerCase() : "",
    phone: isEmail ? undefined : contact,
    occupants,
  };
}

/** Le module doit avoir l'empreinte bancaire active, et Stripe correctement
 * configuré (clé secrète + clé publiable) — commun aux deux routes
 * ci-dessous. */
async function requireCardOnFileReady(entityId: string) {
  const engineConfig = await requireEngineEnabled(entityId);
  if (!engineConfig.cardOnFileMode) throw new HttpError(400, "Empreinte bancaire non activée pour cet établissement");
  const paymentConfig = await prisma.paymentConfig.findUnique({ where: { entityId } });
  if (!paymentConfig?.secretKey || !paymentConfig.publishableKey) {
    throw new HttpError(400, "Paiement Stripe non configuré (clé secrète et clé publiable requises)");
  }
  return { engineConfig, paymentConfig };
}

/**
 * POST /wa/bookingEngine/cardSetupIntent — public. 1er appel du flux
 * empreinte bancaire : crée un Customer Stripe (contact saisi par le
 * client) puis un SetupIntent, et renvoie le clientSecret dont a besoin
 * Stripe.js côté navigateur pour afficher le formulaire de carte (Stripe
 * Elements, avec Apple Pay/Google Pay si disponibles) — aucune donnée de
 * carte ne transite par nos serveurs, ni ici ni ailleurs. La Booking n'est
 * PAS créée à cet appel : seulement après confirmation côté client, via
 * /cardOnFileConfirm ci-dessous.
 */
bookingEngineRouter.post(
  "/bookingEngine/cardSetupIntent",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const { paymentConfig } = await requireCardOnFileReady(entity.id);

    const contact = String(req.body.contact || "").trim();
    if (!contact) throw new HttpError(400, "Téléphone ou email requis");
    const isEmail = contact.includes("@");
    const cardholderName = req.body.cardholderName ? String(req.body.cardholderName).trim() : undefined;

    try {
      const { customerId } = await createSetupIntentCustomer(paymentConfig, {
        ...(isEmail ? { email: contact } : { phone: contact }),
        ...(cardholderName ? { name: cardholderName } : {}),
      });
      const { id, clientSecret } = await createSetupIntent(paymentConfig, { customerId });
      res.status(201).json({ setupIntentId: id, clientSecret, publishableKey: paymentConfig.publishableKey });
    } catch (e) {
      const message = e instanceof PaymentError ? e.message : "Erreur Stripe";
      throw new HttpError(400, message);
    }
  })
);

/**
 * POST /wa/bookingEngine/cardOnFileConfirm — public. 2e et dernier appel du
 * flux empreinte bancaire, une fois stripe.confirmSetup() réussi côté
 * client (cf. booking.html) : relit le SetupIntent auprès de Stripe pour
 * vérifier SERVEUR qu'il a bien le statut "succeeded" avec une carte
 * attachée (jamais fait confiance au seul statut déclaré par le client),
 * puis crée la Booking avec la référence Stripe (customer/paymentMethod)
 * pour un débit manuel ultérieur possible depuis le dashboard Stripe —
 * jamais débitée automatiquement par Sesame Suite.
 */
bookingEngineRouter.post(
  "/bookingEngine/cardOnFileConfirm",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const { paymentConfig } = await requireCardOnFileReady(entity.id);

    const setupIntentId = String(req.body.setupIntentId || "");
    if (!setupIntentId) throw new HttpError(400, "setupIntentId requis");

    let setupIntent;
    try {
      setupIntent = await retrieveSetupIntent(paymentConfig, setupIntentId);
    } catch (e) {
      throw new HttpError(400, e instanceof PaymentError ? e.message : "Erreur Stripe");
    }
    if (setupIntent.status !== "succeeded" || !setupIntent.paymentMethodId) {
      throw new HttpError(400, "Enregistrement de la carte non confirmé — réessayez.");
    }

    const draft = parseCardOnFileDraft(req.body as CardOnFileBody);
    const startDate = new Date(draft.startDate);
    const endDate = new Date(draft.endDate);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || endDate <= startDate) throw new HttpError(400, "Dates invalides");
    draft.stripeCustomerId = setupIntent.customerId || undefined;
    draft.stripePaymentMethodId = setupIntent.paymentMethodId;

    // Pas de quoteBooking ici (contrairement à /checkout et /bookDirect) :
    // aucun montant n'est jamais facturé en empreinte bancaire, or
    // quoteBooking exige un Room.rate renseigné (nécessaire seulement pour
    // calculer un prix à encaisser). createBookingDirectUnpaid revalide déjà
    // lui-même l'existence de la chambre et sa disponibilité (respecte
    // skipAvailabilityCheck) sans cette contrainte de tarif.
    try {
      const booking = await createBookingDirectUnpaid(entity, draft, "empreinte bancaire (accès immédiat, carte non débitée)");
      res.status(201).json({ code: booking.code });
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "Réservation impossible");
    }
  })
);
