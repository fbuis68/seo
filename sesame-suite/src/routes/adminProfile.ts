import { NextFunction, Request, Response, Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";

/**
 * Profils de droits personnalisés par établissement (§ demande client
 * 21/10/2026, panneau "Utilisateurs" > "Profils") — même décentralisation
 * que hotelUser.ts : chaque hôtel gère ses propres profils, jamais un
 * entityId fourni par le body/query. Réservé aux comptes "hotel" (même
 * garde que hotelUser.ts — un compte "housekeeping" n'a de toute façon pas
 * accès au back-office complet).
 */
export const adminProfileRouter = Router();

function requireHotelAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.admin) {
    res.status(401).json({ error: "Authentification admin requise" });
    return;
  }
  if (req.admin.role !== "hotel") {
    res.status(403).json({ error: "Réservé aux comptes admin d'établissement" });
    return;
  }
  next();
}

function shapeProfile(p: { id: string; name: string; menuRights: unknown; createdAt: Date }) {
  return { id: p.id, name: p.name, menuRights: (p.menuRights as Record<string, boolean>) || {} };
}

adminProfileRouter.get(
  "/adminProfile/list",
  requireAdmin,
  requireHotelAdmin,
  asyncHandler(async (req, res) => {
    const rows = await prisma.adminProfile.findMany({
      where: { entityId: req.admin!.entityId },
      orderBy: { name: "asc" },
    });
    res.json(rows.map(shapeProfile));
  })
);

interface CreateBody {
  name?: string;
  menuRights?: Record<string, boolean>;
}

adminProfileRouter.post(
  "/adminProfile/create",
  requireAdmin,
  requireHotelAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body as CreateBody;
    const name = (b.name || "").trim();
    if (!name) throw new HttpError(400, "Nom du profil requis");
    const existing = await prisma.adminProfile.findUnique({ where: { entityId_name: { entityId: req.admin!.entityId, name } } });
    if (existing) throw new HttpError(409, `Un profil "${name}" existe déjà`);
    const row = await prisma.adminProfile.create({
      data: { entityId: req.admin!.entityId, name, menuRights: (b.menuRights || {}) as never },
    });
    res.status(201).json(shapeProfile(row));
  })
);

interface UpdateBody {
  id?: string;
  name?: string;
  menuRights?: Record<string, boolean>;
}

adminProfileRouter.post(
  "/adminProfile/update",
  requireAdmin,
  requireHotelAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body as UpdateBody;
    if (!b.id) throw new HttpError(400, "id requis");
    const existing = await prisma.adminProfile.findFirst({ where: { id: b.id, entityId: req.admin!.entityId } });
    if (!existing) throw new HttpError(404, "Profil introuvable");
    const name = b.name !== undefined ? b.name.trim() : undefined;
    if (name !== undefined && !name) throw new HttpError(400, "Nom du profil requis");
    const row = await prisma.adminProfile.update({
      where: { id: b.id },
      data: { name, menuRights: b.menuRights !== undefined ? (b.menuRights as never) : undefined },
    });
    res.json(shapeProfile(row));
  })
);

/** POST /wa/adminProfile/delete — body: { id }. Les AdminUser rattachés
 * retombent automatiquement à profileId=null (accès complet, comportement
 * par défaut d'un compte "hotel" sans profil) via onDelete:SetNull. */
adminProfileRouter.post(
  "/adminProfile/delete",
  requireAdmin,
  requireHotelAdmin,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.adminProfile.findFirst({ where: { id, entityId: req.admin!.entityId } });
    if (!existing) throw new HttpError(404, "Profil introuvable");
    await prisma.adminProfile.delete({ where: { id } });
    res.json({ ok: true });
  })
);
