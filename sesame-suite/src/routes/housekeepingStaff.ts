import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";

export const housekeepingStaffRouter = Router();

function shapeStaff(s: { id: string; name: string; color: string | null; team: string | null; assignedRoomCodes: unknown }) {
  return {
    id: s.id,
    name: s.name,
    color: s.color || "#2ECC71",
    team: s.team || "",
    assignedRoomCodes: (s.assignedRoomCodes as string[]) || [],
  };
}

/** GET /wa/housekeepingStaff/list — agents de ménage (panneau Planning). */
housekeepingStaffRouter.get(
  "/housekeepingStaff/list",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const staff = await prisma.housekeepingStaff.findMany({ where: { entityId: entity.id }, orderBy: { name: "asc" } });
    res.json(staff.map(shapeStaff));
  })
);

interface StaffBody {
  name: string;
  color?: string;
  team?: string;
  assignedRoomCodes?: string[];
}

housekeepingStaffRouter.post(
  "/housekeepingStaff/create",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as StaffBody;
    if (!b.name) throw new HttpError(400, "name requis");
    const staff = await prisma.housekeepingStaff.create({
      data: { entityId: entity.id, name: b.name, color: b.color || null, team: b.team || null, assignedRoomCodes: b.assignedRoomCodes || [] },
    });
    res.status(201).json(shapeStaff(staff));
  })
);

housekeepingStaffRouter.post(
  "/housekeepingStaff/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const { id, ...b } = req.body as StaffBody & { id: string };
    if (!id) throw new HttpError(400, "id requis");
    const staff = await prisma.housekeepingStaff.findFirst({ where: { id, entityId: entity.id } });
    if (!staff) throw new HttpError(404, "Agent introuvable");
    const updated = await prisma.housekeepingStaff.update({
      where: { id },
      data: { name: b.name, color: b.color, team: b.team, assignedRoomCodes: b.assignedRoomCodes },
    });
    res.json(shapeStaff(updated));
  })
);

/** POST /wa/housekeepingStaff/delete — body: { id } */
housekeepingStaffRouter.post(
  "/housekeepingStaff/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const id = (req.body.id as string) || "";
    const staff = await prisma.housekeepingStaff.findFirst({ where: { id, entityId: entity.id } });
    if (!staff) throw new HttpError(404, "Agent introuvable");
    await prisma.housekeepingStaff.delete({ where: { id } });
    res.json({ ok: true });
  })
);
