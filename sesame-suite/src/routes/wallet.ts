import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import { createHotelPass, WalletError } from "../lib/eldoWallet";
import type { Booking, WalletConfig } from "@prisma/client";

export const walletRouter = Router();

function shapeConfig(c: { enabled: boolean; hotelId: string | null; apiToken: string | null; lang: string }) {
  return {
    enabled: c.enabled,
    hotelId: c.hotelId || "",
    // Le token n'est jamais renvoyé en clair une fois enregistré — même
    // principe que PaymentConfig.secretKey (cf. routes/payment.ts).
    apiTokenSet: !!c.apiToken,
    apiTokenLast4: c.apiToken ? c.apiToken.slice(-4) : "",
    lang: c.lang,
  };
}

/**
 * Génère le pass Wallet d'une réservation, ou renvoie celui déjà enregistré
 * — logique commune au bouton admin ("Réservations") et au bouton client
 * ("Espace client" → Clé digitale, cf. POST /wallet/pass ci-dessous).
 * Idempotent : un pass déjà enregistré n'est jamais recréé (barcode = code
 * de réservation, EldoWallet répondrait 409 de toute façon).
 */
async function getOrCreateWalletPass(config: WalletConfig, booking: Booking, opts: { roomNumber?: string; roomCode?: string } = {}) {
  if (booking.walletPassId) {
    return { id: booking.walletPassId, shortLink: booking.walletShortLink, status: booking.walletStatus };
  }
  const pass = await createHotelPass(config, booking, opts);
  await prisma.booking.update({
    where: { id: booking.id },
    data: {
      walletPassId: pass.id,
      walletShortLink: pass.shortLink,
      walletStatus: pass.status,
      walletCreatedAt: new Date(),
    },
  });
  return pass;
}


/** GET /wa/wallet/config — réglages du connecteur EldoWallet de cet établissement (créés vides au besoin). */
walletRouter.get(
  "/wallet/config",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const config = await prisma.walletConfig.upsert({
      where: { entityId: entity.id },
      update: {},
      create: { entityId: entity.id },
    });
    res.json(shapeConfig(config));
  })
);

interface ConfigBody {
  enabled?: boolean;
  hotelId?: string;
  apiToken?: string;
  lang?: string;
}

/** POST /wa/wallet/config/update — un apiToken vide conserve la valeur déjà enregistrée. */
walletRouter.post(
  "/wallet/config/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as ConfigBody;
    const data = {
      enabled: b.enabled,
      hotelId: b.hotelId,
      ...(b.apiToken ? { apiToken: b.apiToken } : {}),
      lang: b.lang || "fr",
    };
    const config = await prisma.walletConfig.upsert({
      where: { entityId: entity.id },
      update: data,
      create: { entityId: entity.id, ...data },
    });
    res.json(shapeConfig(config));
  })
);

/**
 * POST /wa/wallet/booking/:code/pass — génère le pass Wallet d'une
 * réservation (panneau admin "Réservations", écran de détail). Idempotent
 * côté app : si un pass a déjà été enregistré sur cette réservation, on le
 * renvoie tel quel plutôt que de rappeler EldoWallet (qui répondrait de
 * toute façon 409 puisque barcode = code de réservation, cf.
 * lib/eldoWallet.ts createHotelPass).
 */
walletRouter.post(
  "/wallet/booking/:code/pass",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const code = req.params.code;
    const booking = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code } } });
    if (!booking) throw new HttpError(404, "Réservation introuvable");

    const config = await prisma.walletConfig.findUnique({ where: { entityId: entity.id } });
    if (!config || !config.enabled) throw new HttpError(400, "Wallet non configuré pour cet établissement");

    const b = req.body as { roomNumber?: string; roomCode?: string };
    try {
      const pass = await getOrCreateWalletPass(config, booking, {
        roomNumber: b.roomNumber || booking.facilityName || booking.facilityCode || undefined,
        roomCode: b.roomCode || booking.selectedRoomCode || booking.facilityCode || undefined,
      });
      res.status(201).json(pass);
    } catch (e) {
      if (e instanceof WalletError) throw new HttpError(400, e.message);
      throw e;
    }
  })
);

/**
 * POST /wa/wallet/pass — body: { code } — génère (ou renvoie) le pass
 * Wallet de la réservation depuis l'Espace client (checkin.html, onglet
 * "Clé digitale", bouton "Ajouter au Wallet"). Comme /booking/accessQr et
 * /booking/openDoor, accessible sans authentification staff : le code de
 * réservation fait office de jeton, seul identifiant que le client
 * connaît. Si le connecteur Wallet n'est pas activé pour cet établissement,
 * renvoie enabled:false plutôt qu'une erreur — le client masque alors le
 * bouton (cf. checkin.html espRenderWalletButton) au lieu d'afficher un
 * message d'erreur pour une fonctionnalité que l'hôtel n'a pas souscrite.
 */
walletRouter.post(
  "/wallet/pass",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const code = ((req.body.code as string) || "").trim();
    if (!code) throw new HttpError(400, "code requis");

    const booking = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code } } });
    if (!booking) throw new HttpError(404, "Réservation introuvable");

    const config = await prisma.walletConfig.findUnique({ where: { entityId: entity.id } });
    if (!config || !config.enabled) {
      res.json({ enabled: false });
      return;
    }

    try {
      const pass = await getOrCreateWalletPass(config, booking, {
        roomNumber: booking.facilityName || booking.facilityCode || undefined,
        roomCode: booking.selectedRoomCode || booking.facilityCode || undefined,
      });
      res.status(201).json({ enabled: true, ...pass });
    } catch (e) {
      if (e instanceof WalletError) throw new HttpError(400, e.message);
      throw e;
    }
  })
);
