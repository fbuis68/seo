import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { normaliseBooking } from "../lib/normalize";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { fireTrigger } from "../lib/automation";
import { requireAdmin } from "../middleware/requireAdmin";
import { encodeNfc, BookingSourceError } from "../lib/bookingSource";

export const bookingRouter = Router();

/**
 * GET /wa/booking/list?entityCode=&q=&email=
 *
 * - `q`   : recherche libre (email, code réservation ou nom) — étape 1 du check-in.
 * - `email`: filtre exact (insensible à la casse) — historique espace client.
 * Remplace DEMO_BOOKINGS / ESP_DEMO_BOOKINGS de l'ancien prototype par une
 * source unique en base.
 */
bookingRouter.get(
  "/booking/list",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const q = ((req.query.q as string) || "").trim();
    const email = ((req.query.email as string) || "").trim();

    const bookings = await prisma.booking.findMany({
      where: { entityId: entity.id },
      orderBy: { startDate: "desc" },
    });

    let list = bookings;
    if (email) {
      const el = email.toLowerCase();
      list = list.filter((b) => b.personEmail.toLowerCase() === el);
    } else if (q) {
      const ql = q.toLowerCase();
      list = list.filter(
        (b) =>
          b.personEmail.toLowerCase().includes(ql) ||
          b.code.toLowerCase().includes(ql) ||
          b.personLastname.toLowerCase().includes(ql)
      );
    }

    res.json(list.map(normaliseBooking));
  })
);

/**
 * POST /wa/booking/checkin
 * body: { entityCode, code, status, selectedRoomCode }
 * Finalise le check-in (étape 7) — statut confirmed|checkedin, chambre choisie.
 */
bookingRouter.post(
  "/booking/checkin",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const { code, status, selectedRoomCode } = req.body as {
      code: string;
      status?: string;
      selectedRoomCode?: string;
    };
    if (!code) throw new HttpError(400, "code requis");

    const booking = await prisma.booking.findUnique({
      where: { entityId_code: { entityId: entity.id, code } },
    });
    if (!booking) throw new HttpError(404, "Réservation introuvable");

    const updated = await prisma.booking.update({
      where: { id: booking.id },
      data: {
        checkinDone: true,
        status: status || "checkedin",
        selectedRoomCode: selectedRoomCode || booking.selectedRoomCode,
      },
    });

    fireTrigger("checkin.completed", {
      entityId: entity.id,
      targetType: "booking",
      targetId: updated.id,
      recipient: { email: updated.personEmail, phone: updated.personPhone },
      variables: { prenom: updated.personFirstname, nom: updated.personLastname, code: updated.code },
    }).catch((e) => console.error("[automation] checkin.completed:", e));

    res.json(normaliseBooking(updated));
  })
);

/**
 * POST /wa/booking/update — édition admin d'une réservation (panneau
 * "Arrivées du jour") : contact, dates de séjour, chambre. Réservé aux
 * comptes admin (contrairement à /booking/checkin, appelé sans auth par le
 * parcours check-in éco du client lui-même).
 */
bookingRouter.post(
  "/booking/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as {
      code: string;
      startDate?: string;
      endDate?: string;
      facilityCode?: string;
      personFirstname?: string;
      personLastname?: string;
      personEmail?: string;
      personPhone?: string;
    };
    if (!b.code) throw new HttpError(400, "code requis");

    const booking = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code: b.code } } });
    if (!booking) throw new HttpError(404, "Réservation introuvable");

    const startDate = b.startDate ? new Date(b.startDate) : booking.startDate;
    const endDate = b.endDate ? new Date(b.endDate) : booking.endDate;
    if (isNaN(startDate.getTime())) throw new HttpError(400, "Date d'arrivée invalide");
    if (isNaN(endDate.getTime())) throw new HttpError(400, "Date de départ invalide");
    if (endDate <= startDate) throw new HttpError(400, "La date de départ doit être après la date d'arrivée");

    const data: Record<string, unknown> = { startDate, endDate };
    if (b.personFirstname !== undefined) data.personFirstname = b.personFirstname.trim();
    if (b.personLastname !== undefined) data.personLastname = b.personLastname.trim();
    if (b.personEmail !== undefined) {
      if (!b.personEmail.trim()) throw new HttpError(400, "Email requis");
      data.personEmail = b.personEmail.trim();
    }
    if (b.personPhone !== undefined) data.personPhone = b.personPhone.trim() || null;
    if (b.facilityCode !== undefined) {
      const code = b.facilityCode.trim();
      const room = code ? await prisma.room.findUnique({ where: { entityId_code: { entityId: entity.id, code } } }) : null;
      data.facilityCode = code || null;
      data.facilityName = room?.name || null;
      data.selectedRoomCode = code || null;
      data.roomId = room?.id || null;
    }

    const updated = await prisma.booking.update({ where: { id: booking.id }, data });
    res.json(normaliseBooking(updated));
  })
);

/**
 * POST /wa/booking/encodeNfc — body: { code } — déclenche l'encodage d'une
 * carte/badge NFC pour cette réservation auprès de la source externe
 * configurée sur "Intégration réservations" (cf. lib/bookingSource.ts,
 * encodeNfc — inerte tant que nfcEndpointPath n'est pas renseigné).
 */
bookingRouter.post(
  "/booking/encodeNfc",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const code = (req.body.code as string) || "";
    if (!code) throw new HttpError(400, "code requis");

    const booking = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code } } });
    if (!booking) throw new HttpError(404, "Réservation introuvable");

    const config = await prisma.bookingSourceConfig.findUnique({ where: { entityId: entity.id } });
    if (!config) throw new HttpError(400, "Connecteur non configuré pour cet établissement");

    try {
      const { count } = await encodeNfc(config, booking.code);
      const updated = await prisma.booking.update({
        where: { id: booking.id },
        data: { nfcCount: { increment: count }, nfcEncodedAt: new Date() },
      });
      res.json(normaliseBooking(updated));
    } catch (e) {
      if (e instanceof BookingSourceError) throw new HttpError(400, e.message);
      throw e;
    }
  })
);
