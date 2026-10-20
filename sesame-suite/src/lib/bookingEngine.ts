import type { Entity, Order } from "@prisma/client";
import { prisma } from "../db";
import { fireTrigger } from "./automation";
import { computeTaxeSejourAmount } from "./payment";
import { bookingTemplateVars, hotelContactInfo } from "./templateVars";
import { adoptBookingIntoSource } from "./bookingSource";

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
  // Sélection multiple (saisie manuelle uniquement, cf. createManual) —
  // une réservation = plusieurs chambres (groupe/famille), même convention
  // que Booking.selectedRoomCode côté check-in client (liste séparée par
  // des virgules dans facilityCode, cf. espGetAccessPoints) : une clé
  // numérique par chambre. roomId reste requis (chambre "principale", 1ère
  // de la liste) pour tout code qui n'attend qu'une seule chambre —
  // ignoré si roomIds est fourni avec plus d'un élément.
  roomIds?: string[];
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
  // Empreinte bancaire (BookingEngineConfig.cardOnFileMode) — référence
  // Stripe de la carte enregistrée sans être débitée, cf. Booking.
  // stripeCustomerId/stripePaymentMethodId (schema.prisma).
  stripeCustomerId?: string;
  stripePaymentMethodId?: string;
}

function nightsBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000));
}

/**
 * BookingEngineConfig.skipAvailabilityCheck/cardOnFileMode — requête dédiée
 * (plutôt que de faire porter les flags par tous les appelants) car les
 * points de contrôle ci-dessous (listAvailableRooms, quoteBooking,
 * createBookingDirect) n'ont pas tous le même objet en main, seul entityId
 * leur est commun.
 * - skipAvailabilityCheck : ressource sans notion d'occupation exclusive
 *   (ex: accès magasin) — le planning des Booking existantes n'est jamais
 *   consulté, ni pour filtrer la liste ni pour bloquer une création.
 * - cardOnFileMode : empreinte bancaire, jamais de montant facturé — une
 *   Room sans Room.rate renseigné reste éligible (listAvailableRooms exige
 *   normalement rate>0, nécessaire seulement pour calculer un prix Stripe
 *   Checkout à encaisser, hors de propos ici).
 */
async function getBookingEngineFlags(entityId: string): Promise<{ skipAvailabilityCheck: boolean; cardOnFileMode: boolean }> {
  const cfg = await prisma.bookingEngineConfig.findUnique({ where: { entityId }, select: { skipAvailabilityCheck: true, cardOnFileMode: true } });
  return { skipAvailabilityCheck: !!cfg?.skipAvailabilityCheck, cardOnFileMode: !!cfg?.cardOnFileMode };
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
/**
 * Avant le 16/09/2026 : une requête `isRoomAvailable` PAR chambre, attendue
 * séquentiellement dans la boucle — un établissement à 80 chambres faisait
 * donc 81 allers-retours DB l'un après l'autre pour une simple recherche de
 * disponibilité (confirmé par test de charge : ~587ms médian / ~33 req/s à
 * seulement 20 connexions concurrentes). Remplacé par UNE requête groupée
 * (toutes les réservations chevauchant la période, pour toutes les
 * chambres candidates à la fois) puis un filtrage en mémoire — 2 requêtes
 * au total quel que soit le nombre de chambres.
 */
export async function listAvailableRooms(entityId: string, start: Date, end: Date): Promise<AvailableRoom[]> {
  const nights = nightsBetween(start, end);
  if (nights <= 0) return [];

  const { skipAvailabilityCheck, cardOnFileMode } = await getBookingEngineFlags(entityId);
  const rooms = await prisma.room.findMany({
    where: { entityId, available: true, ...(cardOnFileMode ? {} : { rate: { gt: 0 } }) },
    orderBy: { name: "asc" },
  });
  if (!rooms.length) return [];

  const unavailableRoomIds = skipAvailabilityCheck
    ? new Set<string>()
    : new Set(
        (
          await prisma.booking.findMany({
            where: {
              roomId: { in: rooms.map((r) => r.id) },
              status: { not: "cancelled" },
              startDate: { lt: end },
              endDate: { gt: start },
            },
            select: { roomId: true },
          })
        ).map((b) => b.roomId)
      );

  return rooms
    .filter((room) => !unavailableRoomIds.has(room.id))
    .map((room) => ({
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
    }));
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
  const { skipAvailabilityCheck } = await getBookingEngineFlags(entityId);
  if (!skipAvailabilityCheck && !(await isRoomAvailable(room.id, start, end))) {
    throw new Error("Cette chambre n'est plus disponible sur ces dates");
  }

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
  const roomIds = draft.roomIds?.length ? draft.roomIds : [draft.roomId];
  const rooms = await prisma.room.findMany({ where: { id: { in: roomIds }, entityId: entity.id } });
  if (rooms.length !== roomIds.length) {
    const missing = roomIds.filter((id) => !rooms.some((r) => r.id === id));
    throw new Error(`Chambre ${missing.join(", ")} introuvable`);
  }
  // Conserve l'ordre choisi par l'appelant (findMany ne le garantit pas) —
  // roomIds[0] reste la chambre "principale" affichée partout ailleurs.
  const orderedRooms = roomIds.map((id) => rooms.find((r) => r.id === id)!);
  const room = orderedRooms[0];

  const { skipAvailabilityCheck } = await getBookingEngineFlags(entity.id);
  if (!skipAvailabilityCheck) {
    for (const r of orderedRooms) {
      if (!(await isRoomAvailable(r.id, start, end))) {
        if (opts.onRaceLost === "reject") throw new Error("Cette chambre n'est plus disponible sur ces dates");
        console.error(`[bookingEngine] chambre ${r.code} déjà prise sur la période (${opts.source}) — réservation créée quand même, à vérifier manuellement`);
      }
    }
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
      facilityCode: orderedRooms.map((r) => r.code).join(","),
      facilityName: orderedRooms.map((r) => r.name).join(", "),
      bookingType: draft.bookingType || null,
      stripeCustomerId: draft.stripeCustomerId || null,
      stripePaymentMethodId: draft.stripePaymentMethodId || null,
      status: "confirmed",
      occupants: {
        create: Object.entries(draft.occupants || {})
          .filter(([, count]) => count > 0)
          .flatMap(([ageCategory, count]) => Array.from({ length: count }, () => ({ ageCategory }))),
      },
    },
  });

  // Fait connaître la réservation à la source externe dès sa création,
  // quel que soit le chemin emprunté (réservation en ligne payée ou non,
  // empreinte bancaire, saisie manuelle staff) — centralisé ici plutôt que
  // dupliqué par appelant : avant ce correctif, seules POST
  // /booking/createManual et PUT /booking/update le déclenchaient, laissant
  // TOUTE réservation créée via le widget public "Réservation en ligne"
  // (bookDirect/cardOnFile/paiement Stripe confirmé) sans jamais tenter
  // d'adoption — demande client 15/10/2026, "les résas créées côté
  // admin.sesame ne sont pas envoyées" (symptôme constaté avec des
  // résas RES... issues précisément de ce flux). Awaité (pas fire-and-
  // forget) pour que le résultat (notamment un warning à afficher) soit
  // disponible à l'appelant, et pour éviter toute course avec un second
  // appel redondant côté route.
  //
  // PLACÉ AVANT fireTrigger ci-dessous (inversion délibérée, 16/10/2026,
  // demande client "faire un appel api en création directement... pour
  // éviter la synchronisation et pouvoir envoyer immédiatement le code
  // dès la réservation faite") : fireTrigger déclenche potentiellement un
  // envoi automatique (SMS/email "Réservation créée") dont le modèle peut
  // référencer {{codeAcces}}/{{qrCode}}, lesquels interrogent la source
  // externe pour CETTE réservation (cf. lib/messaging.ts fetchAccessQr).
  // Avec l'ancien ordre (fireTrigger en fire-and-forget AVANT l'adoption,
  // elle awaitée), l'envoi automatique pouvait partir — et donc interroger
  // la source — AVANT que la réservation n'y soit connue, renvoyant un
  // code vide une fois sur deux selon le timing. Le planificateur
  // bookingSourceScheduler (sync périodique, 60s) reste un filet de
  // sécurité si cette adoption immédiate échoue, mais n'est plus le seul
  // chemin.
  const adopted = await adoptBookingIntoSource(entity.id, booking).catch((e) => ({ booking, warning: e instanceof Error ? e.message : String(e) }));

  hotelContactInfo(entity.id).then(async (hotel) =>
    fireTrigger("booking.created", {
      entityId: entity.id,
      targetType: "booking",
      targetId: adopted.booking.id,
      recipient: { email: adopted.booking.personEmail, phone: adopted.booking.personPhone },
      variables: await bookingTemplateVars(adopted.booking, hotel),
    })
  ).catch((e) => console.error("[automation] booking.created:", e));

  return adopted;
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

  const { booking, warning } = await createBookingDirect(entity, draft, { source: `order payé ${order.id}`, onRaceLost: "createAnyway" });
  if (warning) console.error(`[bookingEngine] createBookingFromPaidOrder(${booking.code}) — adoption source externe échouée :`, warning);
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
/** Même correctif N+1 que listAvailableRooms ci-dessus (une seule requête
 * groupée pour toutes les chambres plutôt qu'une par chambre) — cf. audit
 * charge du 16/09/2026, ce même anti-motif retrouvé ici en creusant. */
export async function listRoomsForStaff(entityId: string, start: Date, end: Date): Promise<StaffRoomOption[]> {
  const nights = Math.max(0, nightsBetween(start, end));
  const rooms = await prisma.room.findMany({ where: { entityId, available: true }, orderBy: { name: "asc" } });
  if (!rooms.length) return [];

  const unavailableRoomIds = new Set<string>();
  if (nights > 0) {
    const overlapping = await prisma.booking.findMany({
      where: {
        roomId: { in: rooms.map((r) => r.id) },
        status: { not: "cancelled" },
        startDate: { lt: end },
        endDate: { gt: start },
      },
      select: { roomId: true },
    });
    overlapping.forEach((b) => b.roomId && unavailableRoomIds.add(b.roomId));
  }

  return rooms.map((room) => ({
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
    occupied: unavailableRoomIds.has(room.id),
  }));
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
  const roomIds = draft.roomIds?.length ? draft.roomIds : [draft.roomId];
  const rooms = await prisma.room.findMany({ where: { id: { in: roomIds }, entityId } });
  if (rooms.length !== roomIds.length) throw new Error("Chambre introuvable");
}
