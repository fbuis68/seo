import { Router } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { normaliseBooking } from "../lib/normalize";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { config } from "../config";

export const authRouter = Router();

/**
 * POST /api/auth/guest-login
 * body: { email, code }
 *
 * Remplace la vérification locale contre ESP_DEMO_BOOKINGS de l'ancien
 * prototype (espDoLogin()) par une vraie recherche en base — priorité
 * "Critique" du dossier de lancement (§10.4 "Auth espace client").
 * Le token n'est utilisé que côté client, en mémoire, pour la durée de
 * l'onglet — comme le S.checkinDone d'origine, il ne survit pas au rechargement.
 */
authRouter.post(
  "/auth/guest-login",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const email = ((req.body.email as string) || "").trim().toLowerCase();
    const code = ((req.body.code as string) || "").trim().toUpperCase();
    if (!email || !code) throw new HttpError(400, "Email et code de réservation requis");

    const bookings = await prisma.booking.findMany({ where: { entityId: entity.id } });
    const booking = bookings.find((b) => b.personEmail.toLowerCase() === email && b.code.toUpperCase() === code);
    if (!booking) throw new HttpError(401, "Email ou code de réservation incorrect.");

    const token = jwt.sign({ entityId: entity.id, bookingId: booking.id, email }, config.jwtSecret, {
      expiresIn: "12h",
    });

    res.json({ token, booking: normaliseBooking(booking) });
  })
);
