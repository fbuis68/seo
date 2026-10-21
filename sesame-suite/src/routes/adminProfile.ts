import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame, requireCrmAdmin } from "../middleware/requireAdmin";

/**
 * Profils de droits personnalisés (§ demande client 21/10/2026 — révisé le
 * même jour : "les profils doivent être créés au niveau de super-admin et
 * seul super-admin peut attribuer des droits aux utilisateurs des
 * différentes entités") — réservé au super-admin Sesame (crmRole=admin,
 * requireCrmAdmin), PAS un self-service hôtel (contrairement à
 * hotelUser.ts). Opère sur ACTIVE_ENTITY_CODE comme le panneau "Opérateurs
 * Sesame" (resolveEntity) : le super-admin bascule d'établissement via le
 * panneau "Entités" puis gère ici les profils et leur affectation pour
 * l'établissement actif.
 */
export const adminProfileRouter = Router();

function shapeProfile(p: { id: string; name: string; menuRights: unknown; createdAt: Date }) {
  return { id: p.id, name: p.name, menuRights: (p.menuRights as Record<string, boolean>) || {} };
}

adminProfileRouter.get(
  "/adminProfile/list",
  requireAdmin,
  requireSesame,
  requireCrmAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const rows = await prisma.adminProfile.findMany({
      where: { entityId: entity.id },
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
  requireSesame,
  requireCrmAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as CreateBody;
    const name = (b.name || "").trim();
    if (!name) throw new HttpError(400, "Nom du profil requis");
    const existing = await prisma.adminProfile.findUnique({ where: { entityId_name: { entityId: entity.id, name } } });
    if (existing) throw new HttpError(409, `Un profil "${name}" existe déjà pour cet établissement`);
    const row = await prisma.adminProfile.create({
      data: { entityId: entity.id, name, menuRights: (b.menuRights || {}) as never },
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
  requireSesame,
  requireCrmAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body as UpdateBody;
    if (!b.id) throw new HttpError(400, "id requis");
    const existing = await prisma.adminProfile.findUnique({ where: { id: b.id } });
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
  requireSesame,
  requireCrmAdmin,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.adminProfile.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Profil introuvable");
    await prisma.adminProfile.delete({ where: { id } });
    res.json({ ok: true });
  })
);

/** GET /wa/adminProfile/usersByEntity — comptes "hotel" de l'établissement
 * actif, avec leur profil actuel — pour l'écran d'affectation. */
adminProfileRouter.get(
  "/adminProfile/usersByEntity",
  requireAdmin,
  requireSesame,
  requireCrmAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const rows = await prisma.adminUser.findMany({
      where: { entityId: entity.id, role: "hotel" },
      orderBy: { createdAt: "asc" },
      include: { profile: { select: { id: true, name: true } } },
    });
    res.json(
      rows.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name || "",
        active: u.active,
        profileId: u.profileId || null,
        profileName: u.profile?.name || null,
      }))
    );
  })
);

interface AssignBody {
  userId?: string;
  profileId?: string | null;
}

/** POST /wa/adminProfile/assignUser — affecte (ou retire, profileId=null)
 * un profil à un compte "hotel" de l'établissement actif. Seul point
 * d'écriture de AdminUser.profileId — § demande client 21/10/2026 : "seul
 * super-admin peut attribuer des droits aux utilisateurs des différentes
 * entités". */
adminProfileRouter.post(
  "/adminProfile/assignUser",
  requireAdmin,
  requireSesame,
  requireCrmAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as AssignBody;
    if (!b.userId) throw new HttpError(400, "userId requis");
    const user = await prisma.adminUser.findFirst({ where: { id: b.userId, entityId: entity.id, role: "hotel" } });
    if (!user) throw new HttpError(404, "Utilisateur introuvable pour cet établissement");

    let profileId: string | null = null;
    if (b.profileId) {
      const profile = await prisma.adminProfile.findFirst({ where: { id: b.profileId, entityId: entity.id } });
      if (!profile) throw new HttpError(400, "Profil introuvable pour cet établissement");
      profileId = profile.id;
    }

    await prisma.adminUser.update({ where: { id: user.id }, data: { profileId } });
    res.json({ ok: true });
  })
);
