import { Router } from "express";
import QRCode from "qrcode";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { normaliseBooking } from "../lib/normalize";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { fireTrigger } from "../lib/automation";
import { requireAdmin } from "../middleware/requireAdmin";
import { encodeNfc, listNfcDevices, fetchAccessQr, openDoor, pushBookingUpdate, adoptBookingIntoSource, BookingSourceError } from "../lib/bookingSource";
import { sendEmailRaw } from "../lib/email";
import { listRoomsForStaff, validateManualBookingDraft, createBookingDirectUnpaid, BookingDraft, OCCUPANT_AGE_CATEGORIES } from "../lib/bookingEngine";

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

    let updated = await prisma.booking.update({ where: { id: booking.id }, data });

    // Répercussion best-effort vers la source externe — jamais bloquante.
    let pushWarning: string | undefined;
    if (updated.importedFrom) {
      // Réservation déjà connue de la source (chambre, statut, type de
      // réservation et/ou dates) — cf. lib/bookingSource.ts pushBookingUpdate.
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
    } else {
      // Réservation encore locale-only (jamais importée) — tentative
      // d'adoption complète (cf. adoptBookingIntoSource) : si acceptée par
      // la source, active le QR/l'ouverture de porte réels pour cette
      // réservation. Silencieuse en cas d'échec (pas de sourcePushWarning
      // ici) — un établissement sans connecteur capable de créer ne doit
      // pas voir un avertissement à chaque modification.
      updated = await adoptBookingIntoSource(entity.id, updated).catch(() => updated);
    }

    res.json({ ...normaliseBooking(updated), sourcePushWarning: pushWarning || null });
  })
);

/**
 * POST /wa/booking/checkinStart — body: { code } — marque le début du
 * check-in en ligne côté client (étape "Connecté" de la frise du parcours
 * client, panneau Réservations). Public (pas requireAdmin) : appelé par
 * checkin.html au moment où le client sélectionne sa réservation dans
 * l'appli de check-in — avant que le formulaire ne soit rempli/terminé
 * (checkinDone), donc distinct. Idempotent : n'écrase jamais une date déjà
 * posée (le client peut revenir plusieurs fois sur son check-in).
 */
bookingRouter.post(
  "/booking/checkinStart",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const code = (req.body.code as string) || "";
    if (!code) throw new HttpError(400, "code requis");
    const booking = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code } } });
    if (!booking) throw new HttpError(404, "Réservation introuvable");
    if (!booking.checkinStartedAt) {
      await prisma.booking.update({ where: { id: booking.id }, data: { checkinStartedAt: new Date() } });
    }
    res.json({ ok: true });
  })
);

/**
 * POST /wa/booking/delete — body: { code } — suppression DÉFINITIVE d'une
 * réservation (distincte de "Désactiver", qui ne fait que passer status à
 * "cancelled" et reste réversible). Bloquée si des commandes room service
 * ou un enregistrement de taxe de séjour existent pour cette réservation
 * (données comptables/fiscales — ne doivent jamais disparaître
 * silencieusement) : ces cas doivent passer par "Désactiver" à la place.
 * Occupants et vérifications d'identité (KYC) sont supprimés en cascade
 * (données annexes propres à la réservation, cf. schema.prisma).
 */
bookingRouter.post(
  "/booking/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const code = (req.body.code as string) || "";
    if (!code) throw new HttpError(400, "code requis");
    const booking = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code } } });
    if (!booking) throw new HttpError(404, "Réservation introuvable");

    const [orderCount, taxeCount] = await Promise.all([
      prisma.order.count({ where: { bookingId: booking.id } }),
      prisma.taxeSejourRecord.count({ where: { bookingId: booking.id } }),
    ]);
    if (orderCount > 0 || taxeCount > 0) {
      throw new HttpError(
        400,
        "Impossible de supprimer : des commandes ou un enregistrement de taxe de séjour sont liés à cette réservation — utilisez plutôt \"Désactiver\"."
      );
    }

    await prisma.booking.delete({ where: { id: booking.id } });
    res.json({ ok: true });
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
    // Pas de garde sur l'existence du connecteur ici : un accès coché
    // "Encodeur NFC" (Gestion des Accès) doit apparaître dans ce sélecteur
    // même si l'établissement n'a jamais configuré l'Intégration
    // réservations — seul listNfcDevices() sait si un repli sur la liste
    // externe est nécessaire (aucun encodeur local marqué).
    const config = await prisma.bookingSourceConfig.findUnique({ where: { entityId: entity.id } });
    try {
      const devices = await listNfcDevices(entity.id, config);
      res.json(devices);
    } catch (e) {
      if (e instanceof BookingSourceError) throw new HttpError(400, e.message);
      throw e;
    }
  })
);

/**
 * POST /wa/booking/encodeNfc — body: { code, deviceId, passId? } — déclenche
 * l'encodage d'une carte/badge NFC sur le lecteur `deviceId` choisi, auprès
 * de la source externe configurée sur "Intégration réservations" (cf.
 * lib/bookingSource.ts, encodeNfc — inerte tant que nfcStartEndpointPath
 * n'est pas renseigné). Bloquant jusqu'à ~15s (durée de la fenêtre pendant
 * laquelle la carte doit être approchée du lecteur).
 *
 * `passId` (notre id interne Pass.id, PAS l'externalId Sesame) cible
 * l'invité précis à encoder — une réservation avec plusieurs Pass
 * (invitations, cf. modèle Pass) nécessite une carte par personne. Omis =
 * comportement historique (booking.passId, un seul invité).
 */
bookingRouter.post(
  "/booking/encodeNfc",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const code = (req.body.code as string) || "";
    const deviceId = (req.body.deviceId as string) || "";
    const passId = (req.body.passId as string) || "";
    if (!code) throw new HttpError(400, "code requis");
    if (!deviceId) throw new HttpError(400, "deviceId requis — sélectionnez un lecteur NFC");

    const booking = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code } } });
    if (!booking) throw new HttpError(404, "Réservation introuvable");

    const config = await prisma.bookingSourceConfig.findUnique({ where: { entityId: entity.id } });
    if (!config) throw new HttpError(400, "Connecteur non configuré pour cet établissement");

    let pass: { id: string; externalId: string } | null = null;
    if (passId) {
      const row = await prisma.pass.findUnique({ where: { id: passId } });
      if (!row || row.bookingId !== booking.id) throw new HttpError(404, "Pass introuvable pour cette réservation");
      pass = row;
    }
    const targetPassId = pass ? pass.externalId : booking.passId;
    if (!targetPassId) throw new HttpError(400, "Aucun identifiant \"Pass\" pour cette réservation — ré-importez-la depuis la source externe");

    try {
      const { success, message } = await encodeNfc(config, targetPassId, deviceId);
      if (!success) throw new HttpError(400, message || "Association NFC échouée");
      const updatedBooking = pass
        ? booking
        : await prisma.booking.update({ where: { id: booking.id }, data: { nfcCount: { increment: 1 }, nfcEncodedAt: new Date() } });
      const updatedPass = pass
        ? await prisma.pass.update({ where: { id: pass.id }, data: { nfcCount: { increment: 1 }, nfcEncodedAt: new Date() } })
        : null;
      res.json({ ...normaliseBooking(updatedBooking), pass: updatedPass ? shapePass(updatedPass) : undefined });
    } catch (e) {
      if (e instanceof BookingSourceError) throw new HttpError(400, e.message);
      throw e;
    }
  })
);

function shapePass(p: {
  id: string;
  bookingId: string;
  externalId: string;
  personFirstname: string;
  personLastname: string;
  personEmail: string | null;
  master: boolean;
  facilityCode: string | null;
  facilityName: string | null;
  status: string | null;
  activated: boolean;
  nfcCount: number;
  nfcEncodedAt: Date | null;
}) {
  return {
    id: p.id,
    bookingId: p.bookingId,
    externalId: p.externalId,
    personFirstname: p.personFirstname,
    personLastname: p.personLastname,
    personEmail: p.personEmail || "",
    master: p.master,
    facilityCode: p.facilityCode || "",
    facilityName: p.facilityName || "",
    status: p.status || "",
    activated: p.activated,
    nfcCount: p.nfcCount,
    nfcEncodedAt: p.nfcEncodedAt ? p.nfcEncodedAt.toISOString() : null,
  };
}

/**
 * GET /wa/booking/passes?code= — liste les Pass (invitations) d'une
 * réservation (panneau "Réservations", écran de détail) — admin uniquement.
 */
bookingRouter.get(
  "/booking/passes",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const code = (req.query.code as string) || "";
    if (!code) throw new HttpError(400, "code requis");
    const booking = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code } } });
    if (!booking) throw new HttpError(404, "Réservation introuvable");
    const passes = await prisma.pass.findMany({ where: { bookingId: booking.id }, orderBy: [{ master: "desc" }, { createdAt: "asc" }] });
    res.json(passes.map(shapePass));
  })
);

/**
 * GET /wa/booking/passesPublic?code= — même chose, sans authentification
 * (espace client, cf. checkin.html) — affiche la liste des invités de SA
 * PROPRE réservation. Ne renvoie rien de plus sensible que ce que le client
 * voit déjà de sa propre réservation (noms/emails des co-invités).
 */
bookingRouter.get(
  "/booking/passesPublic",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const code = (req.query.code as string) || "";
    if (!code) throw new HttpError(400, "code requis");
    const booking = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code } } });
    if (!booking) throw new HttpError(404, "Réservation introuvable");
    const passes = await prisma.pass.findMany({ where: { bookingId: booking.id }, orderBy: [{ master: "desc" }, { createdAt: "asc" }] });
    res.json(passes.map(shapePass));
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
      // Sans connecteur réel, checkin.html ignore ce champ et affiche son
      // propre pattern de démonstration (cf. espRenderQr) — généré quand
      // même ici pour les panneaux staff (admin.html/reservations.html, cf.
      // "Générer une clé"), qui affichent toujours un vrai QR scannable
      // plutôt qu'un motif factice, encodant simplement le code de
      // réservation.
      const demoQrImage = await QRCode.toDataURL(booking.code, { margin: 1, width: 320 });
      res.json({ simulated: true, qrImage: demoQrImage });
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

/**
 * GET /wa/booking/availableRooms?start=&end= — réservé au personnel
 * (panneau Réservations, bouton "Créer une réservation"). N'EST PAS soumis
 * au module "Réservation en ligne" (BookingEngineConfig) : une saisie
 * manuelle par le personnel est une fonctionnalité de gestion des
 * réservations à part entière, pas l'usage self-service que ce module
 * active pour le public. Contrairement à la page publique booking.html,
 * renvoie TOUTES les chambres (avec un indicateur `occupied`, jamais
 * filtrées) : le personnel peut avoir besoin de choisir une chambre déjà
 * occupée (clé supplémentaire pour un accompagnant, clé staff).
 */
bookingRouter.get(
  "/booking/availableRooms",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const start = new Date(req.query.start as string);
    const end = new Date(req.query.end as string);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) throw new HttpError(400, "Dates invalides");
    const rooms = await listRoomsForStaff(entity.id, start, end);
    res.json({ rooms });
  })
);

interface CreateManualBody {
  roomId: string;
  startDate: string;
  endDate: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  occupants?: Record<string, number>;
  bookingType?: string;
}

/**
 * POST /wa/booking/createManual — réservé au personnel (panneau
 * Réservations, bouton "Créer une réservation") : saisie manuelle d'une
 * réservation (téléphone, guichet…), créée directement sans paiement —
 * jamais soumise à BookingEngineConfig.requirePayment, qui ne concerne que
 * la page publique booking.html. Les occupants sont optionnels ici
 * (contrairement à la réservation en ligne) : le personnel les collecte
 * souvent plus tard, au check-in. AUCUN contrôle bloquant de disponibilité
 * ni de tarif (cf. validateManualBookingDraft) : le personnel peut avoir
 * besoin de rajouter une clé à une réservation déjà en place (chambre
 * occupée), ou de créer une clé "staff" sans rapport avec l'occupation
 * réelle — toujours créée, jamais refusée pour un chevauchement.
 */
bookingRouter.post(
  "/booking/createManual",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as CreateManualBody;
    if (!b.roomId) throw new HttpError(400, "Chambre requise");
    if (!b.firstName?.trim() || !b.lastName?.trim()) throw new HttpError(400, "Nom et prénom requis");
    if (!b.email?.trim() || !b.email.includes("@")) throw new HttpError(400, "Email valide requis");

    const occupants: Record<string, number> = {};
    for (const cat of OCCUPANT_AGE_CATEGORIES) {
      const n = Math.max(0, Math.floor(Number(b.occupants?.[cat]) || 0));
      if (n) occupants[cat] = n;
    }
    const draft: BookingDraft = {
      roomId: b.roomId,
      startDate: b.startDate,
      endDate: b.endDate,
      firstName: b.firstName.trim(),
      lastName: b.lastName.trim(),
      email: b.email.trim().toLowerCase(),
      phone: b.phone?.trim() || undefined,
      bookingType: b.bookingType?.trim() || undefined,
      occupants,
    };

    try {
      await validateManualBookingDraft(entity.id, draft); // dates + existence de la chambre uniquement
      let booking = await createBookingDirectUnpaid(entity, draft, "saisie manuelle (personnel)", "createAnyway");
      // Tentative best-effort de faire connaître cette réservation à la
      // source externe (cf. adoptBookingIntoSource) — jamais bloquante :
      // sans connecteur capable de créer, ou si l'appel échoue, la
      // réservation reste utilisable, seuls le QR/l'ouverture de porte
      // resteront en mode simulé.
      booking = await adoptBookingIntoSource(entity.id, booking).catch(() => booking);
      res.status(201).json(normaliseBooking(booking));
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "Réservation impossible");
    }
  })
);
