import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { normaliseBooking } from "../lib/normalize";
import { asyncHandler, HttpError } from "../lib/asyncHandler";

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

    res.json(normaliseBooking(updated));
  })
);
