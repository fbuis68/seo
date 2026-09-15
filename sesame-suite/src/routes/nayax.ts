import { randomBytes } from "crypto";
import { Router } from "express";
import QRCode from "qrcode";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import { createAccessSession, getSessionByToken, handleWebhookEvent, NayaxError } from "../lib/nayax";

export const nayaxRouter = Router();

function shapeConfig(c: { enabled: boolean; webhookSecret: string | null; terminalIdPath: string | null; sessionWindowSeconds: number; lastWebhookAt: Date | null; lastWebhookEventCount: number }) {
  return {
    enabled: c.enabled,
    webhookSecret: c.webhookSecret || "",
    terminalIdPath: c.terminalIdPath || "terminalId",
    sessionWindowSeconds: c.sessionWindowSeconds,
    lastWebhookAt: c.lastWebhookAt,
    lastWebhookEventCount: c.lastWebhookEventCount,
  };
}

/** GET /wa/nayaxConfig — réglages Nayax de cet établissement (créés vides au besoin). */
nayaxRouter.get(
  "/nayaxConfig",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    let config = await prisma.nayaxConfig.upsert({ where: { entityId: entity.id }, update: {}, create: { entityId: entity.id } });
    if (!config.webhookSecret) {
      config = await prisma.nayaxConfig.update({ where: { id: config.id }, data: { webhookSecret: randomBytes(24).toString("hex") } });
    }
    res.json(shapeConfig(config));
  })
);

/** POST /wa/nayaxConfig — body: { enabled?, terminalIdPath?, sessionWindowSeconds? } */
nayaxRouter.post(
  "/nayaxConfig",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as { enabled?: boolean; terminalIdPath?: string; sessionWindowSeconds?: number };
    const config = await prisma.nayaxConfig.upsert({
      where: { entityId: entity.id },
      update: {
        enabled: b.enabled,
        terminalIdPath: b.terminalIdPath,
        sessionWindowSeconds: b.sessionWindowSeconds ? Math.max(15, Math.min(600, Number(b.sessionWindowSeconds))) : undefined,
      },
      create: {
        entityId: entity.id,
        enabled: b.enabled || false,
        terminalIdPath: b.terminalIdPath || "terminalId",
        sessionWindowSeconds: b.sessionWindowSeconds ? Math.max(15, Math.min(600, Number(b.sessionWindowSeconds))) : undefined,
      },
    });
    res.json(shapeConfig(config));
  })
);

/** POST /wa/nayaxConfig/webhook/regenerate — invalide l'URL de webhook actuelle et en émet une nouvelle. */
nayaxRouter.post(
  "/nayaxConfig/webhook/regenerate",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const config = await prisma.nayaxConfig.upsert({
      where: { entityId: entity.id },
      update: { webhookSecret: randomBytes(24).toString("hex") },
      create: { entityId: entity.id, webhookSecret: randomBytes(24).toString("hex") },
    });
    res.json(shapeConfig(config));
  })
);

/**
 * GET /wa/nayaxAccess/qr?room=CODE — QR Code (data URL) à imprimer/afficher
 * sur ou près du lecteur Nayax, encodant le lien vers la page publique de
 * réservation (nayax-access.html). Réservé au personnel (panneau "Gestion
 * des Accès") — même usage que le QR "Générer une clé" côté réservations
 * (cf. QRCode.toDataURL dans routes/booking.ts).
 */
nayaxRouter.get(
  "/nayaxAccess/qr",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const roomCode = String(req.query.room || "");
    if (!roomCode) throw new HttpError(400, "room requis");
    const room = await prisma.room.findUnique({ where: { entityId_code: { entityId: entity.id, code: roomCode } } });
    if (!room) throw new HttpError(404, "Accès introuvable");

    const url = `${req.protocol}://${req.get("host")}/nayax-access.html?room=${encodeURIComponent(roomCode)}&entityCode=${encodeURIComponent(entity.code)}`;
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 });
    res.json({ url, dataUrl });
  })
);

/**
 * GET /wa/nayaxAccess/start?entityCode=&room=CODE — page publique de
 * réservation (nayax-access.html) : crée la session "pending" au moment où
 * le client scanne le QR Code de cet accès. Public (pas de requireAdmin) —
 * c'est le visiteur, pas un membre du personnel, qui déclenche cet appel.
 */
nayaxRouter.get(
  "/nayaxAccess/start",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const roomCode = String(req.query.room || "");
    if (!roomCode) throw new HttpError(400, "room requis");
    try {
      const { session, room } = await createAccessSession(entity, roomCode);
      res.json({ token: session.token, expiresAt: session.expiresAt, roomName: room.name });
    } catch (e) {
      if (e instanceof NayaxError) throw new HttpError(404, e.message);
      throw e;
    }
  })
);

/** GET /wa/nayaxAccess/status?token= — poll depuis la page publique (pending | activated | expired | cancelled | failed). */
nayaxRouter.get(
  "/nayaxAccess/status",
  asyncHandler(async (req, res) => {
    const token = String(req.query.token || "");
    if (!token) throw new HttpError(400, "token requis");
    const session = await getSessionByToken(token);
    if (!session) throw new HttpError(404, "Session introuvable");
    res.json({ status: session.status, expiresAt: session.expiresAt, roomName: session.room.name });
  })
);

/**
 * POST /wa/nayax/webhook/:secret — reçoit les notifications Nayax. Forme
 * exacte du payload non confirmée (devzone.nayax.com inaccessible depuis
 * cet environnement) : l'extraction de l'identifiant de terminal passe par
 * NayaxConfig.terminalIdPath (configurable), à ajuster une fois un payload
 * réel observé. Toujours 200 — un webhook Nayax ne doit jamais échouer côté
 * Sesame, même sans correspondance (mauvais terminal, pas de session en
 * attente…).
 */
nayaxRouter.post(
  "/nayax/webhook/:secret",
  asyncHandler(async (req, res) => {
    const config = await prisma.nayaxConfig.findUnique({ where: { webhookSecret: req.params.secret }, include: { entity: true } });
    if (!config) throw new HttpError(404, "Webhook inconnu");

    await prisma.nayaxConfig.update({
      where: { id: config.id },
      data: { lastWebhookAt: new Date(), lastWebhookEventCount: { increment: 1 } },
    });

    const result = config.enabled ? await handleWebhookEvent(config.entity, config, req.body) : { matched: false, reason: "intégration désactivée" };
    res.json({ success: true, ...result });
  })
);
