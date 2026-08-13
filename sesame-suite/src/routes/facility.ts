import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { normaliseRoom } from "../lib/normalize";
import { asyncHandler } from "../lib/asyncHandler";

export const facilityRouter = Router();

/** GET /wa/facility/list?entityCode=&available=true — chambres de l'hôtel. */
facilityRouter.get(
  "/facility/list",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const onlyAvailable = req.query.available === "true";
    const rooms = await prisma.room.findMany({
      where: { entityId: entity.id, ...(onlyAvailable ? { available: true } : {}) },
      orderBy: { code: "asc" },
    });
    res.json(rooms.map(normaliseRoom));
  })
);
