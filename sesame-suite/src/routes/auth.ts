import { Router } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../db";
import { normaliseBooking } from "../lib/normalize";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { config } from "../config";

export const authRouter = Router();

/**
 * POST /api/auth/guest-login
 * body: { email, code } OU { lastname, code }
 *
 * Remplace la vérification locale contre ESP_DEMO_BOOKINGS de l'ancien
 * prototype (espDoLogin()) par une vraie recherche en base — priorité
 * "Critique" du dossier de lancement (§10.4 "Auth espace client").
 * Le token n'est utilisé que côté client, en mémoire, pour la durée de
 * l'onglet — comme le S.checkinDone d'origine, il ne survit pas au rechargement.
 *
 * Pour une appli en production servant TOUS les établissements depuis une
 * même URL (pas de ?entityCode=... par lien dédié à un hôtel), la
 * combinaison email+code ou nom+code doit suffire à la fois à authentifier
 * ET à déterminer l'établissement — la recherche porte donc sur TOUTES les
 * réservations de TOUS les établissements plutôt que sur un entityId déjà
 * résolu en amont (ancien comportement : resolveEntity(req), qui exigeait
 * un ?entityCode= ou retombait sur le tenant par défaut).
 */
authRouter.post(
  "/auth/guest-login",
  asyncHandler(async (req, res) => {
    const email = ((req.body.email as string) || "").trim().toLowerCase();
    const lastname = ((req.body.lastname as string) || "").trim();
    const code = ((req.body.code as string) || "").trim();
    if (!code || (!email && !lastname)) {
      throw new HttpError(400, "Email (ou nom) et code de réservation requis");
    }

    const bookings = await prisma.booking.findMany({
      where: {
        code: { equals: code, mode: "insensitive" },
        ...(email ? { personEmail: { equals: email, mode: "insensitive" } } : {}),
        ...(lastname ? { personLastname: { equals: lastname, mode: "insensitive" } } : {}),
      },
      include: { entity: true },
    });

    if (bookings.length === 0) {
      throw new HttpError(401, email ? "Email ou code de réservation incorrect." : "Nom ou code de réservation incorrect.");
    }
    // Un nom de famille est nettement moins discriminant qu'un email — en cas
    // de correspondance multiple (coïncidence entre établissements distincts,
    // ex : plusieurs "Martin" avec un code similaire), refuser plutôt que de
    // deviner et risquer d'exposer la réservation d'un autre client.
    if (bookings.length > 1) {
      throw new HttpError(
        409,
        email
          ? "Plusieurs réservations correspondent — contactez l'hôtel."
          : "Plusieurs réservations correspondent à ce nom — utilisez votre email plutôt que votre nom."
      );
    }

    const booking = bookings[0];
    const token = jwt.sign({ entityId: booking.entityId, bookingId: booking.id, email: email || undefined }, config.jwtSecret, {
      expiresIn: "12h",
    });

    res.json({ token, entityCode: booking.entity.code, booking: normaliseBooking(booking) });
  })
);

/**
 * POST /api/auth/autologin
 * body: { token } — jeton {{lienAutologin}} (cf. lib/templateVars.ts),
 * valable jusqu'à 2 jours après le départ plutôt que 12h comme le token de
 * session ci-dessus : un lien envoyé par email doit rester utilisable
 * pendant tout le séjour, pas seulement dans les heures suivant l'envoi.
 * Vérifié puis échangé contre un token de session classique (12h, même
 * forme que guest-login) — checkin.html traite ensuite exactement comme
 * une connexion manuelle réussie (cf. espApplyLogin).
 */
authRouter.post(
  "/auth/autologin",
  asyncHandler(async (req, res) => {
    const raw = (req.body.token as string) || "";
    if (!raw) throw new HttpError(400, "Lien invalide");

    let payload: { entityId?: string; bookingId?: string; email?: string };
    try {
      payload = jwt.verify(raw, config.jwtSecret) as typeof payload;
    } catch {
      throw new HttpError(401, "Ce lien a expiré ou n'est plus valide.");
    }
    if (!payload.bookingId) throw new HttpError(401, "Lien invalide");

    const booking = await prisma.booking.findUnique({ where: { id: payload.bookingId }, include: { entity: true } });
    if (!booking) throw new HttpError(404, "Réservation introuvable");

    const token = jwt.sign(
      { entityId: booking.entityId, bookingId: booking.id, email: payload.email || undefined },
      config.jwtSecret,
      { expiresIn: "12h" }
    );
    res.json({ token, entityCode: booking.entity.code, booking: normaliseBooking(booking) });
  })
);
