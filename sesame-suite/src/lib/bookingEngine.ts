import type { Entity, Order } from "@prisma/client";
import { prisma } from "../db";
import { fireTrigger } from "./automation";
import { computeTaxeSejourAmount } from "./payment";
import { bookingTemplateVars, hotelContactInfo } from "./templateVars";

// Module "Réservation en ligne" (09/09/2026) — page publique
// (public/booking.html) : un visiteur choisit ses dates, voit les chambres
// disponibles et paie directement en ligne (chambre + taxe de séjour). La
// disponibilité se calcule à la volée à partir de Room.rate et des Booking
// déjà posées sur la période — pas de calendrier de disponibilité ni de
// tarification saisonnière dédiés (hors périmètre v1, cf. Room.rate = tarif
// fixe par nuit).

export const OCCUPANT_AGE_CATEGORIES = ["adulte", "ado", "enfant", "bebe"] as const;
export type OccupantAgeCategory = (typeof OCCUPANT_AGE_CATEGORIES)[number];

export interface BookingDraft {
  roomId: string;
  startDate: string; // ISO
  endDate: string; // ISO
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  occupants: Record<string, number>; // ageCategory -> count
  // Groupe/catégorie de réservation (Booking.bookingType) — optionnel,
  // saisi uniquement depuis la création manuelle (panneau Réservations).
  // Porte aussi, côté source externe (ex : API Sesame Technology), la
  // notion de "grouping" qui rattache la réservation à un ensemble
  // d'accès plutôt qu'à un seul (cf. lib/bookingSource.ts pushBookingUpsert) —
  // transmis dès la création si renseigné, plutôt que seulement à l'édition.
  bookingType?: string;
}

function nightsBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000));
}

/** Une chambre est indisponible sur la période si une réservation ACTIVE
 * (tout statut sauf "cancelled") chevauche l'intervalle demandé — même
 * logique de chevauchement standard (début < fin demandée ET fin > début
 * demandé). */
async function isRoomAvailable(roomId: string, start: Date, end: Date, excludeBookingId?: string): Promise<boolean> {
  const overlapping = await prisma.booking.findFirst({
    where: {
      roomId,
      status: { not: "cancelled" },
      startDate: { lt: end },
      endDate: { gt: start },
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
    },
    select: { id: true },
  });
  return !overlapping;
}

export interface AvailableRoom {
  id: string;
  code: string;
  name: string;
  category: string | null;
  type: string | null;
  capacity: number | null;
  description: string | null;
  photos: string[];
  rate: number;
  nights: number;
  roomTotal: number;
}

/** Chambres disponibles pour cet établissement sur la période demandée,
 * avec le prix total déjà calculé (Room.rate × nuits) — jamais 0 nuit ni
 * chambre sans tarif renseigné (rate null/0), sinon rien à facturer. */
export async function listAvailableRooms(entityId: string, start: Date, end: Date): Promise<AvailableRoom[]> {
  const nights = nightsBetween(start, end);
  if (nights <= 0) return [];

  const rooms = await prisma.room.findMany({
    where: { entityId, available: true, rate: { gt: 0 } },
    orderBy: { name: "asc" },
  });

  const results: AvailableRoom[] = [];
  for (const room of rooms) {
    if (await isRoomAvailable(room.id, start, end)) {
      results.push({
        id: room.id,
        code: room.code,
        name: room.name,
        category: room.category,
        type: room.type,
        capacity: room.capacity,
        description: room.description,
        photos: (room.photos as string[]) || [],
        rate: room.rate || 0,
        nights,
        roomTotal: Math.round((room.rate || 0) * nights * 100) / 100,
      });
    }
  }
  return results;
}

export interface BookingQuote {
  room: AvailableRoom;
  taxeSejour: { amount: number; label: string } | null;
  total: number;
}

/** Calcule le montant total à facturer (chambre + taxe de séjour si
 * applicable) pour un brouillon de réservation — jamais fait confiance à un
 * montant transmis par le client, recalculé ici côté serveur avant chaque
 * session Stripe Checkout (cf. routes/bookingEngine.ts /checkout). */
export async function quoteBooking(entityId: string, draft: BookingDraft): Promise<BookingQuote> {
  const start = new Date(draft.startDate);
  const end = new Date(draft.endDate);
  const nights = nightsBetween(start, end);
  if (nights <= 0) throw new Error("Dates invalides");

  const room = await prisma.room.findFirst({ where: { id: draft.roomId, entityId, available: true } });
  if (!room || !room.rate) throw new Error("Chambre introuvable ou indisponible");
  if (!(await isRoomAvailable(room.id, start, end))) throw new Error("Cette chambre n'est plus disponible sur ces dates");

  const roomTotal = Math.round(room.rate * nights * 100) / 100;
  const availableRoom: AvailableRoom = {
    id: room.id,
    code: room.code,
    name: room.name,
    category: room.category,
    type: room.type,
    capacity: room.capacity,
    description: room.description,
    photos: (room.photos as string[]) || [],
    rate: room.rate,
    nights,
    roomTotal,
  };

  const cfg = await prisma.entityModuleConfig.findUnique({ where: { entityId } });
  const taxeSejour = cfg
    ? computeTaxeSejourAmount({ tarifs: (cfg.tarifs as number[]) || [], stars: cfg.stars, exoEnf: cfg.exoEnf, reducAdos: cfg.reducAdos }, draft.occupants, nights)
    : null;

  return { room: availableRoom, taxeSejour, total: Math.round((roomTotal + (taxeSejour?.amount || 0)) * 100) / 100 };
}

/** Génère un code de réservation lisible et unique pour l'établissement
 * (contrairement aux réservations importées, dont le code vient de la
 * source externe — cf. Booking.code) — préfixe "RES" + date + suffixe
 * aléatoire, quelques essais en cas de collision improbable. */
async function generateBookingCode(entityId: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    const code = `RES${datePart}${suffix}`;
    const existing = await prisma.booking.findUnique({ where: { entityId_code: { entityId, code } } });
    if (!existing) return code;
  }
  throw new Error("Impossible de générer un code de réservation unique");
}

/**
 * Crée la Booking (+ Occupant) à partir d'un brouillon — cœur commun à
 * createBookingFromPaidOrder (paiement en ligne confirmé) et à la création
 * directe (paiement sur place choisi par le client sur booking.html, ou
 * réservation saisie manuellement par le personnel depuis le panneau
 * Réservations, cf. routes/booking.ts POST /booking/createManual). Revérifie
 * la disponibilité de la chambre une dernière fois (fenêtre de course rare
 * entre deux réservations simultanées sur la même chambre) : `onRaceLost`
 * décide quoi faire selon l'appelant (paiement déjà encaissé → créer quand
 * même et avertir, vs. pas encore payé → refuser proprement).
 */
async function createBookingDirect(entity: Entity, draft: BookingDraft, opts: { source: string; onRaceLost: "createAnyway" | "reject" }) {
  const start = new Date(draft.startDate);
  const end = new Date(draft.endDate);
  const room = await prisma.room.findFirst({ where: { id: draft.roomId, entityId: entity.id } });
  if (!room) throw new Error(`Chambre ${draft.roomId} introuvable`);

  if (!(await isRoomAvailable(room.id, start, end))) {
    if (opts.onRaceLost === "reject") throw new Error("Cette chambre n'est plus disponible sur ces dates");
    console.error(`[bookingEngine] chambre ${room.code} déjà prise sur la période (${opts.source}) — réservation créée quand même, à vérifier manuellement`);
  }

  const code = await generateBookingCode(entity.id);
  const booking = await prisma.booking.create({
    data: {
      entityId: entity.id,
      code,
      personEmail: draft.email,
      personFirstname: draft.firstName,
      personLastname: draft.lastName,
      personPhone: draft.phone || null,
      startDate: start,
      endDate: end,
      roomId: room.id,
      facilityCode: room.code,
      facilityName: room.name,
      bookingType: draft.bookingType || null,
      status: "confirmed",
      occupants: {
        create: Object.entries(draft.occupants || {})
          .filter(([, count]) => count > 0)
          .flatMap(([ageCategory, count]) => Array.from({ length: count }, () => ({ ageCategory }))),
      },
    },
  });

  hotelContactInfo(entity.id).then((hotel) =>
    fireTrigger("booking.created", {
      entityId: entity.id,
      targetType: "booking",
      targetId: booking.id,
      recipient: { email: booking.personEmail, phone: booking.personPhone },
      variables: bookingTemplateVars(booking, hotel),
    })
  ).catch((e) => console.error("[automation] booking.created:", e));

  return booking;
}

/**
 * Crée la Booking correspondant à un Order "bookingEngine" dont le paiement
 * vient d'être confirmé (cf. webhook checkout.session.completed dans
 * routes/payment.ts) — jamais appelée avant, pour ne jamais bloquer une
 * chambre sur un panier abandonné. Le client a déjà payé : la réservation
 * est créée même si la chambre a été prise entre-temps (onRaceLost:
 * "createAnyway"), plutôt que de lui faire perdre sa chambre silencieusement
 * — pas de remboursement automatique en v1.
 */
export async function createBookingFromPaidOrder(entity: Entity, order: Order) {
  const draft = order.bookingDraft as unknown as BookingDraft | null;
  if (!draft) throw new Error(`Order ${order.id} (bookingEngine) sans bookingDraft`);

  const booking = await createBookingDirect(entity, draft, { source: `order payé ${order.id}`, onRaceLost: "createAnyway" });
  await prisma.order.update({ where: { id: order.id }, data: { bookingId: booking.id, bookingCode: booking.code } });
  return booking;
}

/**
 * Réservation créée directement sans paiement — soit le client a choisi
 * "payer sur place" sur booking.html (cf. routes/bookingEngine.ts POST
 * /bookingEngine/bookDirect, uniquement si BookingEngineConfig.requirePayment
 * est false — onRaceLost:"reject", un visiteur public ne doit pas pouvoir
 * doubler une chambre déjà prise sans même payer), soit le personnel la
 * saisit manuellement depuis le panneau Réservations (cf. routes/booking.ts
 * POST /booking/createManual — onRaceLost:"createAnyway" : le personnel
 * peut délibérément vouloir une chambre déjà occupée, ex. rajouter une clé
 * pour un accompagnant sur une réservation existante, ou créer une clé
 * "staff" sans lien avec l'occupation réelle — jamais bloqué).
 */
export async function createBookingDirectUnpaid(entity: Entity, draft: BookingDraft, source: string, onRaceLost: "createAnyway" | "reject" = "reject") {
  return createBookingDirect(entity, draft, { source, onRaceLost });
}

export interface StaffRoomOption extends AvailableRoom {
  occupied: boolean;
}

/**
 * Chambres pour le sélecteur du panneau admin "Créer une réservation" —
 * contrairement à listAvailableRooms (page publique, qui ne montre QUE les
 * chambres libres et avec un tarif renseigné), ceci renvoie TOUTES les
 * chambres actives, avec un simple indicateur `occupied` : le personnel
 * peut avoir besoin de choisir une chambre déjà occupée (clé
 * supplémentaire pour un accompagnant, clé staff) ou sans tarif configuré
 * (aucune facturation prévue pour ce type de clé).
 */
export async function listRoomsForStaff(entityId: string, start: Date, end: Date): Promise<StaffRoomOption[]> {
  const nights = Math.max(0, nightsBetween(start, end));
  const rooms = await prisma.room.findMany({ where: { entityId, available: true }, orderBy: { name: "asc" } });

  const results: StaffRoomOption[] = [];
  for (const room of rooms) {
    const occupied = nights > 0 ? !(await isRoomAvailable(room.id, start, end)) : false;
    results.push({
      id: room.id,
      code: room.code,
      name: room.name,
      category: room.category,
      type: room.type,
      capacity: room.capacity,
      description: room.description,
      photos: (room.photos as string[]) || [],
      rate: room.rate || 0,
      nights,
      roomTotal: Math.round((room.rate || 0) * nights * 100) / 100,
      occupied,
    });
  }
  return results;
}

/**
 * Valide un brouillon de réservation saisi manuellement — dates + existence
 * de la chambre uniquement, JAMAIS sa disponibilité ni son tarif
 * (contrairement à quoteBooking, utilisé par le parcours payant) : le
 * personnel choisit délibérément la chambre depuis listRoomsForStaff, en
 * connaissance de cause si elle est déjà occupée ou sans tarif.
 */
export async function validateManualBookingDraft(entityId: string, draft: BookingDraft): Promise<void> {
  const start = new Date(draft.startDate);
  const end = new Date(draft.endDate);
  if (nightsBetween(start, end) <= 0) throw new Error("Dates invalides");
  const room = await prisma.room.findFirst({ where: { id: draft.roomId, entityId } });
  if (!room) throw new Error("Chambre introuvable");
}
