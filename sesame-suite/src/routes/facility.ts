import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { normaliseRoom } from "../lib/normalize";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";

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
      },
    });
    res.json(normaliseRoom(updated));
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
