import { Router } from "express";
import QRCode from "qrcode";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { normaliseBooking } from "../lib/normalize";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { fireTrigger } from "../lib/automation";
import { requireAdmin } from "../middleware/requireAdmin";
import { encodeNfc, listNfcDevices, fetchAccessQr, openDoor, pushBookingUpdate, BookingSourceError } from "../lib/bookingSource";
import { sendEmailRaw } from "../lib/email";

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
      status?: string;
      bookingType?: string;
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
    let roomCodeChanged: string | null | undefined;
    if (b.facilityCode !== undefined) {
      const code = b.facilityCode.trim();
      const room = code ? await prisma.room.findUnique({ where: { entityId_code: { entityId: entity.id, code } } }) : null;
      data.facilityCode = code || null;
      data.facilityName = room?.name || null;
      data.selectedRoomCode = code || null;
      data.roomId = room?.id || null;
      roomCodeChanged = code || null;
    }
    if (b.status !== undefined) {
      if (!["confirmed", "checkin_done", "completed", "cancelled"].includes(b.status)) {
        throw new HttpError(400, "Statut invalide");
      }
      data.status = b.status;
    }
    let bookingTypeChanged: string | null | undefined;
    if (b.bookingType !== undefined) {
      const bt = b.bookingType.trim();
      data.bookingType = bt || null;
      bookingTypeChanged = bt || null;
    }
    // Dates de séjour — toujours envoyées par le formulaire d'édition (pas
    // seulement en cas de changement réel), même convention que roomCode/
    // bookingType ci-dessus : b.startDate/b.endDate !== undefined suffit à
    // déclencher la répercussion.
    const startDateChanged = b.startDate !== undefined ? startDate.toISOString().slice(0, 10) : undefined;
    const endDateChanged = b.endDate !== undefined ? endDate.toISOString().slice(0, 10) : undefined;

    const updated = await prisma.booking.update({ where: { id: booking.id }, data });

    // Répercussion best-effort vers la source externe (chambre, statut,
    // type de réservation et/ou dates) — jamais bloquante, cf.
    // lib/bookingSource.ts pushBookingUpdate.
    let pushWarning: string | undefined;
    if (
      roomCodeChanged !== undefined ||
      b.status !== undefined ||
      bookingTypeChanged !== undefined ||
      startDateChanged !== undefined ||
      endDateChanged !== undefined
    ) {
      const config = await prisma.bookingSourceConfig.findUnique({ where: { entityId: entity.id } });
      if (config) {
        const result = await pushBookingUpdate(config, updated.code, {
          roomCode: roomCodeChanged,
          status: b.status,
          bookingType: bookingTypeChanged,
          startDate: startDateChanged,
          endDate: endDateChanged,
        }).catch((e) => ({ ok: false, error: String(e) }));
        if (!result.ok) pushWarning = result.error;
      }
    }

    res.json({ ...normaliseBooking(updated), sourcePushWarning: pushWarning || null });
  })
);

/**
 * GET /wa/booking/nfcDevices — liste les lecteurs NFC disponibles (menu
 * déroulant "Device" affiché avant de lancer un encodage, panneau
 * "Réservations") — cf. lib/bookingSource.ts, listNfcDevices.
 */
bookingRouter.get(
  "/booking/nfcDevices",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const config = await prisma.bookingSourceConfig.findUnique({ where: { entityId: entity.id } });
    if (!config) throw new HttpError(400, "Connecteur non configuré pour cet établissement");
    try {
      const devices = await listNfcDevices(config);
      res.json(devices);
    } catch (e) {
      if (e instanceof BookingSourceError) throw new HttpError(400, e.message);
      throw e;
    }
  })
);

/**
 * POST /wa/booking/encodeNfc — body: { code, deviceId } — déclenche
 * l'encodage d'une carte/badge NFC pour la personne titulaire de cette
 * réservation (booking.passId), sur le lecteur `deviceId` choisi, auprès de
 * la source externe configurée sur "Intégration réservations" (cf.
 * lib/bookingSource.ts, encodeNfc — inerte tant que nfcStartEndpointPath
 * n'est pas renseigné). Bloquant jusqu'à ~15s (durée de la fenêtre pendant
 * laquelle la carte doit être approchée du lecteur).
 */
bookingRouter.post(
  "/booking/encodeNfc",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const code = (req.body.code as string) || "";
    const deviceId = (req.body.deviceId as string) || "";
    if (!code) throw new HttpError(400, "code requis");
    if (!deviceId) throw new HttpError(400, "deviceId requis — sélectionnez un lecteur NFC");

    const booking = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code } } });
    if (!booking) throw new HttpError(404, "Réservation introuvable");
    if (!booking.passId) throw new HttpError(400, "Aucun identifiant \"Pass\" pour cette réservation — ré-importez-la depuis la source externe");

    const config = await prisma.bookingSourceConfig.findUnique({ where: { entityId: entity.id } });
    if (!config) throw new HttpError(400, "Connecteur non configuré pour cet établissement");

    try {
      const { success, message } = await encodeNfc(config, booking.passId, deviceId);
      if (!success) throw new HttpError(400, message || "Association NFC échouée");
      const updated = await prisma.booking.update({
        where: { id: booking.id },
        data: { nfcCount: { increment: 1 }, nfcEncodedAt: new Date() },
      });
      res.json(normaliseBooking(updated));
    } catch (e) {
      if (e instanceof BookingSourceError) throw new HttpError(400, e.message);
      throw e;
    }
  })
);

/**
 * POST /wa/booking/sendEmail — body: { code, subject, message } — envoie un
 * email libre au client d'une réservation (bouton "Envoyer un email" du
 * détail de réservation, panneau Réservations). Réutilise la config SMTP de
 * l'établissement (cf. lib/email.ts, déjà utilisée par les modèles/règles
 * d'automatisation) — même erreur 400 explicite si aucun SMTP n'est
 * configuré, plutôt qu'un échec silencieux.
 */
bookingRouter.post(
  "/booking/sendEmail",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const code = (req.body.code as string) || "";
    const subject = ((req.body.subject as string) || "").trim();
    const message = ((req.body.message as string) || "").trim();
    if (!code) throw new HttpError(400, "code requis");
    if (!subject) throw new HttpError(400, "Objet requis");
    if (!message) throw new HttpError(400, "Message requis");

    const booking = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code } } });
    if (!booking) throw new HttpError(404, "Réservation introuvable");
    if (!booking.personEmail) throw new HttpError(400, "Cette réservation n'a pas d'adresse email");

    const escaped = message
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
    await sendEmailRaw(entity.id, booking.personEmail, subject, `<p>${escaped}</p>`);
    res.json({ ok: true });
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
 *
 * Idem si CETTE réservation précise n'a pas été importée par le connecteur
 * actuellement configuré (`booking.importedFrom` vide ou différent de
 * `config.sourceName`) : c'est le cas des réservations de démo saisies à la
 * main (ex : jeu de données Hôtel Churchill, utilisé en vente alors que son
 * connecteur Sesame réel est branché en parallèle pour la synchro des
 * vraies réservations) — leur code/facilityCode n'a aucune existence côté
 * Sesame, un appel réel échouerait donc systématiquement (constaté :
 * "réservation introuvable" côté Sesame). Reste simulé pour elles quel que
 * soit l'état du connecteur, plutôt que de casser la démo.
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
    if (!config || !config.qrEndpointPath || booking.importedFrom !== (config.sourceName || "Connecteur externe")) {
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
 * "Simuler l'ouverture" existant. Même repli sur simulated:true, quel que
 * soit l'état du connecteur, quand la réservation elle-même n'a pas été
 * importée par CE connecteur (cf. commentaire équivalent sur
 * /booking/accessQr — jeu de données de démo Hôtel Churchill notamment).
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
    if (!config || !config.doorEndpointPath || booking.importedFrom !== (config.sourceName || "Connecteur externe")) {
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
