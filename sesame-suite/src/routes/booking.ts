import { Router } from "express";
import QRCode from "qrcode";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { normaliseBooking } from "../lib/normalize";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { fireTrigger } from "../lib/automation";
import { requireAdmin } from "../middleware/requireAdmin";
import { encodeNfc, fetchAccessQr, openDoor, BookingSourceError } from "../lib/bookingSource";

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

/**
 * GET /wa/booking/accessQr?code=... — récupère le QR code / code d'accès
 * généré par la source externe (ex : Sesame) pour une réservation. Comme
 * /booking/list et /booking/checkin, accessible sans authentification staff
 * : appelé directement par le client depuis son "Espace client" (onglet
 * "Clé digitale"), le code réservation faisant office de jeton.
 *
 * Si aucun endpoint QR n'est configuré pour cet établissement, renvoie
 * simulated:true plutôt qu'une erreur — le client affiche alors son pattern
 * de démonstration existant (cf. checkin.html, espRenderQr), utile en
 * démo/vente avant que le connecteur réel soit branché. Une fois configuré,
 * un échec de CET endpoint est en revanche une vraie erreur 502 : jamais de
 * repli silencieux sur la démo une fois qu'un vrai connecteur est attendu.
 */
bookingRouter.get(
  "/booking/accessQr",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const code = ((req.query.code as string) || "").trim();
    if (!code) throw new HttpError(400, "code requis");

    const booking = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code } } });
    if (!booking) throw new HttpError(404, "Réservation introuvable");

    const config = await prisma.bookingSourceConfig.findUnique({ where: { entityId: entity.id } });
    if (!config || !config.qrEndpointPath) {
      res.json({ simulated: true });
      return;
    }

    try {
      const { qrImage, qrValue, accessCode, validUntil } = await fetchAccessQr(config, booking.code, booking.personEmail);
      const finalImage = qrImage || (qrValue ? await QRCode.toDataURL(qrValue, { margin: 1, width: 320 }) : undefined);
      if (!finalImage && !accessCode) {
        throw new HttpError(
          502,
          "La source externe n'a renvoyé ni QR code ni code d'accès — vérifiez le mapping (qrImagePath / qrValuePath / qrAccessCodePath) dans les réglages techniques avancés."
        );
      }
      res.json({ simulated: false, qrImage: finalImage, accessCode, validUntil });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (e instanceof BookingSourceError) throw new HttpError(502, e.message);
      throw e;
    }
  })
);

/**
 * POST /wa/booking/openDoor — body: { code, facilityCode? } — déclenche
 * l'ouverture à distance de la porte pour cette réservation (source
 * externe, même connexion que la synchronisation). `facilityCode` est
 * optionnel : quand fourni (ex : un point d'accès distinct cliqué dans la
 * liste "Accès" — cf. checkin.html espOpenAccess), il cible précisément CE
 * point d'accès. Sinon, `booking.facilityCode` est utilisé tel quel : côté
 * Sesame, ce champ peut déjà être une LISTE de codes séparés par des
 * virgules pour une même réservation associée à plusieurs serrures (ex :
 * "201,203" dans la doc officielle "Booking Creation") — openAs accepte
 * cette même liste et ouvre tout d'un coup. `selectedRoomCode` (la chambre
 * choisie par le client à l'étape 2 du parcours, pour l'affichage) n'a
 * PAS vocation à restreindre les accès Sesame de la réservation — l'utiliser
 * ici écraserait par erreur les autres serrures associées par Sesame (ex :
 * accès communs) par la seule chambre sélectionnée, d'où son retrait comme
 * valeur par défaut. Même logique simulated:true que /booking/accessQr si
 * aucun endpoint n'est configuré — le client garde alors son bouton
 * "Simuler l'ouverture" existant.
 */
bookingRouter.post(
  "/booking/openDoor",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const code = (req.body.code as string) || "";
    const facilityCodeOverride = (req.body.facilityCode as string) || "";
    if (!code) throw new HttpError(400, "code requis");

    const booking = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code } } });
    if (!booking) throw new HttpError(404, "Réservation introuvable");

    const config = await prisma.bookingSourceConfig.findUnique({ where: { entityId: entity.id } });
    if (!config || !config.doorEndpointPath) {
      res.json({ simulated: true });
      return;
    }

    try {
      await openDoor(
        config,
        booking.code,
        facilityCodeOverride || booking.facilityCode || booking.selectedRoomCode || null,
        booking.personEmail,
        booking.personLastname,
        booking.personFirstname
      );
      const updated = await prisma.booking.update({
        where: { id: booking.id },
        data: { doorOpenCount: { increment: 1 }, doorLastOpenedAt: new Date() },
      });
      res.json({ simulated: false, opened: true, doorOpenCount: updated.doorOpenCount });
    } catch (e) {
      if (e instanceof BookingSourceError) throw new HttpError(502, e.message);
      throw e;
    }
  })
);
