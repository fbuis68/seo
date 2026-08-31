import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import { createHotelPass, WalletError } from "../lib/eldoWallet";

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

    if (booking.walletPassId) {
      res.json({ id: booking.walletPassId, shortLink: booking.walletShortLink, status: booking.walletStatus });
      return;
    }

    const config = await prisma.walletConfig.findUnique({ where: { entityId: entity.id } });
    if (!config || !config.enabled) throw new HttpError(400, "Wallet non configuré pour cet établissement");

    const b = req.body as { roomNumber?: string; roomCode?: string };
    try {
      const pass = await createHotelPass(config, booking, {
        roomNumber: b.roomNumber || booking.facilityName || booking.facilityCode || undefined,
        roomCode: b.roomCode || booking.selectedRoomCode || booking.facilityCode || undefined,
      });
      await prisma.booking.update({
        where: { id: booking.id },
        data: {
          walletPassId: pass.id,
          walletShortLink: pass.shortLink,
          walletStatus: pass.status,
          walletCreatedAt: new Date(),
        },
      });
      res.status(201).json(pass);
    } catch (e) {
      if (e instanceof WalletError) throw new HttpError(400, e.message);
      throw e;
    }
  })
);
