import { randomBytes } from "crypto";
import { Entity, NayaxAccessSession, Room } from "@prisma/client";
import { prisma } from "../db";
import { getPath, openFacilityDirect, BookingSourceError } from "./bookingSource";

/**
 * Accès "carte bleue = clé Sesame" via un terminal Nayax (cf. discussion du
 * 15/09/2026) : 1) le client scanne un QR Code propre à un accès
 * (Room.type="nayax", Room.deviceId = identifiant du terminal Nayax), ce qui
 * crée une NayaxAccessSession "pending" valable sessionWindowSeconds ; 2) le
 * client présente sa carte sur le terminal ; 3) le webhook Nayax entrant
 * (handleWebhookEvent) identifie QUEL terminal a vu une carte (jamais QUELLE
 * carte — la corrélation se fait par device + fenêtre de temps, pas par
 * identité de carte/PAR, dont la disponibilité en temps réel côté Nayax
 * n'est pas confirmée) et déclenche l'ouverture réelle de l'accès Sesame via
 * le mécanisme déjà existant openFacilityDirect.
 */

const DEFAULT_SESSION_WINDOW_SECONDS = 90;

export class NayaxError extends Error {}

async function expireIfStale(session: NayaxAccessSession): Promise<NayaxAccessSession> {
  if (session.status === "pending" && session.expiresAt.getTime() <= Date.now()) {
    return prisma.nayaxAccessSession.update({ where: { id: session.id }, data: { status: "expired" } });
  }
  return session;
}

/**
 * Crée une nouvelle session pour l'accès `roomCode` — appelé par la page
 * publique de réservation au moment où le client scanne le QR Code. Toute
 * session "pending" précédente sur ce même accès est annulée : un seul
 * client à la fois peut légitimement attendre devant un terminal donné.
 */
export async function createAccessSession(entity: Entity, roomCode: string): Promise<{ session: NayaxAccessSession; room: Room }> {
  const room = await prisma.room.findUnique({ where: { entityId_code: { entityId: entity.id, code: roomCode } } });
  if (!room) throw new NayaxError("Accès introuvable");
  if (room.type !== "nayax") throw new NayaxError("Cet accès n'est pas relié à un terminal Nayax");
  if (!room.deviceId) throw new NayaxError("Cet accès n'a pas d'identifiant de terminal Nayax configuré");

  const config = await prisma.nayaxConfig.findUnique({ where: { entityId: entity.id } });
  const windowSeconds = config?.sessionWindowSeconds || DEFAULT_SESSION_WINDOW_SECONDS;

  await prisma.nayaxAccessSession.updateMany({
    where: { roomId: room.id, status: "pending" },
    data: { status: "cancelled" },
  });

  const session = await prisma.nayaxAccessSession.create({
    data: {
      entityId: entity.id,
      roomId: room.id,
      token: randomBytes(16).toString("hex"),
      expiresAt: new Date(Date.now() + windowSeconds * 1000),
    },
  });
  return { session, room };
}

export async function getSessionByToken(token: string): Promise<(NayaxAccessSession & { room: Room }) | null> {
  const session = await prisma.nayaxAccessSession.findUnique({ where: { token }, include: { room: true } });
  if (!session) return null;
  const fresh = await expireIfStale(session);
  return { ...fresh, room: session.room };
}

/**
 * Traite un événement webhook Nayax entrant : extrait l'identifiant de
 * terminal via NayaxConfig.terminalIdPath (chemin configurable — forme
 * exacte du payload Nayax non confirmée depuis cet environnement), le
 * fait correspondre à un Room (type="nayax", deviceId=terminalId) de cet
 * établissement, puis à la session "pending" la plus récente sur cet accès.
 * Sans correspondance (mauvais terminal, ou personne n'a scanné de QR Code
 * récemment sur ce terminal), l'événement est ignoré silencieusement — un
 * webhook Nayax ne doit jamais faire échouer l'ouverture d'un accès légitime
 * ailleurs.
 */
export async function handleWebhookEvent(
  entity: Entity,
  config: { terminalIdPath: string | null },
  rawBody: unknown
): Promise<{ matched: boolean; opened?: boolean; simulated?: boolean; reason?: string }> {
  const terminalId = getPath(rawBody, config.terminalIdPath || "terminalId");
  if (typeof terminalId !== "string" || !terminalId) {
    return { matched: false, reason: "identifiant de terminal introuvable dans le payload" };
  }

  const room = await prisma.room.findFirst({ where: { entityId: entity.id, type: "nayax", deviceId: terminalId } });
  if (!room) return { matched: false, reason: `aucun accès Nayax avec deviceId="${terminalId}"` };

  const candidate = await prisma.nayaxAccessSession.findFirst({
    where: { roomId: room.id, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  if (!candidate) return { matched: false, reason: "aucune session en attente sur cet accès" };

  const session = await expireIfStale(candidate);
  if (session.status !== "pending") return { matched: false, reason: "session expirée entre-temps" };

  const rawSnippet = JSON.stringify(rawBody).slice(0, 2000);
  const bookingConfig = await prisma.bookingSourceConfig.findUnique({ where: { entityId: entity.id } });

  if (!bookingConfig || !bookingConfig.facilityOpenEndpointPath || !room.externalFacilityId) {
    // Ouverture directe non configurée côté Intégration réservations (ou
    // accès sans identifiant source) — même repli "simulé" que
    // POST /wa/facility/openDirect, pour pouvoir tester tout le parcours
    // (QR → session → webhook) avant confirmation Nayax/branchement matériel.
    await prisma.nayaxAccessSession.update({
      where: { id: session.id },
      data: { status: "activated", activatedAt: new Date(), lastEventRaw: rawSnippet },
    });
    return { matched: true, opened: false, simulated: true };
  }

  try {
    await openFacilityDirect(bookingConfig, room.externalFacilityId);
    await prisma.nayaxAccessSession.update({
      where: { id: session.id },
      data: { status: "activated", activatedAt: new Date(), lastEventRaw: rawSnippet },
    });
    return { matched: true, opened: true, simulated: false };
  } catch (e) {
    const message = e instanceof BookingSourceError ? e.message : "erreur inattendue";
    await prisma.nayaxAccessSession.update({
      where: { id: session.id },
      data: { status: "failed", lastEventRaw: `${rawSnippet} — ERREUR: ${message}` },
    });
    return { matched: true, opened: false, reason: message };
  }
}
