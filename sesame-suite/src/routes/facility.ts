import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { normaliseRoom } from "../lib/normalize";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import { openFacilityDirect, BookingSourceError } from "../lib/bookingSource";

export const facilityRouter = Router();

/**
 * GET /wa/facility/list?entityCode=&available=true&housekeeping=true —
 * chambres de l'hôtel. housekeeping=true exclut les accès marqués "non
 * soumis au ménage" (cf. Room.housekeepingExempt) — utilisé par l'appli
 * tablette du personnel (menage.html) pour son sélecteur de chambre à la
 * création d'une intervention, sans filtrer la liste générale (Gestion
 * des Accès, réservations…) consommée ailleurs.
 */
facilityRouter.get(
  "/facility/list",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const onlyAvailable = req.query.available === "true";
    const onlyHousekeeping = req.query.housekeeping === "true";
    const rooms = await prisma.room.findMany({
      where: {
        entityId: entity.id,
        ...(onlyAvailable ? { available: true } : {}),
        ...(onlyHousekeeping ? { housekeepingExempt: false } : {}),
      },
      orderBy: { code: "asc" },
    });
    res.json(rooms.map(normaliseRoom));
  })
);

interface RoomBody {
  code: string;
  name?: string;
  floor?: number;
  surface?: number;
  category?: string;
  type?: string;
  capacity?: number;
  rate?: number;
  description?: string;
  pmr?: boolean;
  nosmoking?: boolean;
  connected?: boolean;
  tags?: string[];
  photos?: string[];
  available?: boolean;
  x?: number;
  y?: number;
  housekeepingExempt?: boolean;
  deviceId?: string;
  isNfcEncoder?: boolean;
  showOnPlan?: boolean;
}

/** POST /wa/facility/create — CRUD chambres (back-office, panneau "Gestion des chambres"). */
facilityRouter.post(
  "/facility/create",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as RoomBody;
    if (!b.code) throw new HttpError(400, "code requis");

    const existing = await prisma.room.findUnique({ where: { entityId_code: { entityId: entity.id, code: b.code } } });
    if (existing) throw new HttpError(409, `La chambre ${b.code} existe déjà`);

    const room = await prisma.room.create({
      data: {
        entityId: entity.id,
        code: b.code,
        name: b.name || b.code,
        floor: b.floor ?? 0,
        surface: b.surface,
        category: b.category,
        type: b.type,
        capacity: b.capacity,
        rate: b.rate,
        description: b.description,
        pmr: b.pmr || false,
        nosmoking: b.nosmoking !== false,
        connected: b.connected || false,
        tags: b.tags || [],
        photos: b.photos || [],
        available: b.available !== false,
        x: b.x,
        y: b.y,
        housekeepingExempt: b.housekeepingExempt || false,
        deviceId: b.deviceId || undefined,
        isNfcEncoder: b.isNfcEncoder || false,
        // Un casier n'a normalement pas sa place sur le plan de l'hôtel
        // (cf. Room.showOnPlan) — décoché par défaut à la création, mais
        // reste un critère explicite que l'admin peut inverser au besoin.
        showOnPlan: b.showOnPlan !== undefined ? b.showOnPlan : b.type !== "casier",
      },
    });
    await prisma.roomHousekeepingStatus.create({ data: { roomId: room.id, status: "libre" } });
    res.status(201).json(normaliseRoom(room));
  })
);

/** POST /wa/facility/update — body: { code, ...champs à modifier } */
facilityRouter.post(
  "/facility/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as RoomBody & { newCode?: string };
    if (!b.code) throw new HttpError(400, "code requis");

    const room = await prisma.room.findUnique({ where: { entityId_code: { entityId: entity.id, code: b.code } } });
    if (!room) throw new HttpError(404, "Chambre introuvable");

    const updated = await prisma.room.update({
      where: { id: room.id },
      data: {
        code: b.newCode || undefined,
        name: b.name,
        floor: b.floor,
        surface: b.surface,
        category: b.category,
        type: b.type,
        capacity: b.capacity,
        rate: b.rate,
        description: b.description,
        pmr: b.pmr,
        nosmoking: b.nosmoking,
        connected: b.connected,
        tags: b.tags,
        photos: b.photos,
        available: b.available,
        x: b.x,
        y: b.y,
        housekeepingExempt: b.housekeepingExempt,
        deviceId: b.deviceId,
        isNfcEncoder: b.isNfcEncoder,
        showOnPlan: b.showOnPlan,
      },
    });
    res.json(normaliseRoom(updated));
  })
);

/**
 * POST /wa/facility/bulkSetAvailable — body: { type, available } — bascule
 * "Visible et sélectionnable par le client" (Room.available) pour TOUS les
 * accès d'un type donné (ex : masquer tous les casiers d'un coup) sans
 * repasser fiche par fiche. Purement une modification de visibilité client
 * — ne supprime ni ne désactive rien d'autre (les accès restent gérables
 * depuis "Gestion des Accès").
 */
facilityRouter.post(
  "/facility/bulkSetAvailable",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const type = (req.body.type as string) || "";
    const available = req.body.available !== false;
    if (!type) throw new HttpError(400, "type requis");

    const { count } = await prisma.room.updateMany({
      where: { entityId: entity.id, type },
      data: { available },
    });
    res.json({ ok: true, count });
  })
);

/**
 * POST /wa/facility/bulkResetPositions — body: { floor } — remet à zéro la
 * position (x/y) de TOUS les accès d'un étage, en un clic. Sert après le
 * remplacement de l'image du plan d'un étage (Plan de l'hôtel → "Changer") :
 * les anciennes coordonnées ne correspondent plus au nouveau visuel, sans
 * ça il faudrait décocher chaque chambre une par une. Les accès repassent
 * dans la liste "chambre à positionner" pour être replacés sur le nouveau
 * plan ; rien d'autre n'est modifié (nom, photos, disponibilité…).
 */
facilityRouter.post(
  "/facility/bulkResetPositions",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const floor = req.body.floor;
    if (floor === undefined || floor === null) throw new HttpError(400, "floor requis");

    const { count } = await prisma.room.updateMany({
      where: { entityId: entity.id, floor: Number(floor) },
      data: { x: null, y: null },
    });
    res.json({ ok: true, count });
  })
);

/**
 * POST /wa/facility/openDirect — body: { code } — ouvre directement l'accès
 * `code` via Room.externalFacilityId, SANS passer par une réservation (cf.
 * openFacilityDirect dans lib/bookingSource.ts) — contrairement à
 * /wa/booking/openDoor. Utilisé par le bouton "Ouverture à distance" du
 * panneau "Gestion des Accès" : accès de service (ménage, etc.) ouvrable
 * indépendamment de toute réservation active ce jour-là sur cette chambre.
 * Réservé au personnel (requireAdmin) — Gestion des Accès n'est pas exposé
 * côté client.
 */
facilityRouter.post(
  "/facility/openDirect",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const code = (req.body.code as string) || "";
    if (!code) throw new HttpError(400, "code requis");

    const room = await prisma.room.findUnique({ where: { entityId_code: { entityId: entity.id, code } } });
    if (!room) throw new HttpError(404, "Accès introuvable");

    const config = await prisma.bookingSourceConfig.findUnique({ where: { entityId: entity.id } });
    let simulatedReason: string | undefined;
    if (!config) {
      simulatedReason = "Aucune intégration réservations configurée pour cet établissement.";
    } else if (!config.facilityOpenEndpointPath) {
      simulatedReason = "Ouverture directe d'un accès non configurée (réglages techniques avancés).";
    } else if (!room.externalFacilityId) {
      simulatedReason = "Cet accès n'a pas d'identifiant source connu — relancez l'import des chambres.";
    }
    if (simulatedReason || !config || !room.externalFacilityId) {
      res.json({ simulated: true, simulatedReason });
      return;
    }

    try {
      await openFacilityDirect(config, room.externalFacilityId);
      res.json({ simulated: false, opened: true });
    } catch (e) {
      if (e instanceof BookingSourceError) throw new HttpError(502, e.message);
      throw e;
    }
  })
);

/** POST /wa/facility/delete — body: { code } */
facilityRouter.post(
  "/facility/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const code = (req.body.code as string) || "";
    const room = await prisma.room.findUnique({ where: { entityId_code: { entityId: entity.id, code } } });
    if (!room) throw new HttpError(404, "Chambre introuvable");
    await prisma.room.delete({ where: { id: room.id } });
    res.json({ ok: true });
  })
);
