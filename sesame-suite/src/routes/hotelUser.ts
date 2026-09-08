import { NextFunction, Request, Response, Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import { randomPassword } from "../lib/password";

/**
 * Gestion en libre-service de l'équipe d'un hôtel (08/09/2026) — chaque
 * établissement gère ses propres accès (Admin / Ménage), sans passer par
 * le CRM Sesame. Volontairement décentralisé : un compte ne peut gérer que
 * les utilisateurs de son propre établissement (entityId du token, jamais
 * un entityId fourni par le body/query) — cf. adminUser.ts pour la
 * création d'accès pilotée côté CRM (comptes Sesame uniquement).
 *
 * "groupScoped" (cf. AdminUser.groupScoped / resolveEntity) permet de
 * choisir, à la création d'un compte, si SON rôle s'appliquera à ce seul
 * établissement ou à tout le groupe auquel il appartient — mais la gestion
 * de l'équipe elle-même (qui peut créer/modifier/supprimer qui) reste
 * toujours limitée à l'établissement d'origine du compte qui agit.
 */
export const hotelUserRouter = Router();

const ASSIGNABLE_ROLES = ["hotel", "housekeeping"];

/** Réservé aux comptes "hotel" — un compte "housekeeping" est déjà bloqué en
 * amont par housekeepingScope (préfixe /hotelUser absent de la liste
 * blanche), mais on le vérifie aussi ici en défense en profondeur. Les
 * comptes "sesame" gèrent les accès hôtel via adminUser.ts (CRM). */
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

function shapeUser(u: { id: string; email: string; name: string | null; role: string; active: boolean; groupScoped: boolean; createdAt: Date }) {
  return { id: u.id, email: u.email, name: u.name || "", role: u.role, active: u.active, groupScoped: u.groupScoped, createdAt: u.createdAt };
}

/** GET /wa/hotelUser/context — informe l'UI si l'établissement appartient à
 * un groupe (pour n'afficher le sélecteur de portée "tout le groupe" que
 * si c'est pertinent) et liste les autres établissements du groupe. */
hotelUserRouter.get(
  "/hotelUser/context",
  requireAdmin,
  requireHotelAdmin,
  asyncHandler(async (req, res) => {
    const entity = await prisma.entity.findUnique({ where: { id: req.admin!.entityId }, include: { group: true } });
    if (!entity) throw new HttpError(404, "Établissement introuvable");
    let groupEntities: { code: string; name: string }[] = [];
    if (entity.groupId) {
      const rows = await prisma.entity.findMany({ where: { groupId: entity.groupId }, orderBy: { name: "asc" }, select: { code: true, name: true } });
      groupEntities = rows;
    }
    res.json({
      entityCode: entity.code,
      groupId: entity.groupId,
      groupName: entity.group?.name || null,
      groupEntities,
    });
  })
);

/** GET /wa/hotelUser/list — équipe du SEUL établissement du compte appelant. */
hotelUserRouter.get(
  "/hotelUser/list",
  requireAdmin,
  requireHotelAdmin,
  asyncHandler(async (req, res) => {
    const rows = await prisma.adminUser.findMany({
      where: { entityId: req.admin!.entityId },
      orderBy: { createdAt: "asc" },
    });
    res.json(rows.map(shapeUser));
  })
);

interface CreateBody {
  email: string;
  name?: string;
  role?: string;
  groupScoped?: boolean;
}

/** POST /wa/hotelUser/create — le nouveau compte est toujours rattaché au
 * même établissement que le compte qui le crée (entityId du token, jamais
 * du body) : "chaque hôtel gère sa propre équipe". groupScoped=true n'est
 * autorisé que si cet établissement appartient bien à un groupe. */
hotelUserRouter.post(
  "/hotelUser/create",
  requireAdmin,
  requireHotelAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body as CreateBody;
    const email = (b.email || "").trim().toLowerCase();
    if (!email) throw new HttpError(400, "Email requis");
    if (!ASSIGNABLE_ROLES.includes(b.role || "")) throw new HttpError(400, "Rôle invalide (Admin ou Ménage)");

    const existing = await prisma.adminUser.findUnique({ where: { email } });
    if (existing) throw new HttpError(409, `Un compte existe déjà avec l'email ${email}`);

    let groupScoped = false;
    if (b.groupScoped) {
      const entity = await prisma.entity.findUnique({ where: { id: req.admin!.entityId } });
      if (!entity?.groupId) throw new HttpError(400, "Votre établissement n'appartient à aucun groupe");
      groupScoped = true;
    }

    const password = randomPassword();
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.adminUser.create({
      data: { entityId: req.admin!.entityId, email, name: b.name?.trim() || null, passwordHash, role: b.role as string, groupScoped },
    });
    // Le mot de passe généré n'est retourné qu'une fois, en clair.
    res.status(201).json({ ...shapeUser(user), password });
  })
);

interface UpdateBody {
  id: string;
  name?: string;
  role?: string;
  active?: boolean;
  groupScoped?: boolean;
}

hotelUserRouter.post(
  "/hotelUser/update",
  requireAdmin,
  requireHotelAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body as UpdateBody;
    if (!b.id) throw new HttpError(400, "id requis");
    const existing = await prisma.adminUser.findFirst({ where: { id: b.id, entityId: req.admin!.entityId } });
    if (!existing) throw new HttpError(404, "Utilisateur introuvable");
    if (b.active === false && existing.id === req.admin!.adminId) {
      throw new HttpError(400, "Vous ne pouvez pas désactiver votre propre compte");
    }
    if (b.role !== undefined && !ASSIGNABLE_ROLES.includes(b.role)) throw new HttpError(400, "Rôle invalide (Admin ou Ménage)");

    let groupScoped: boolean | undefined = b.groupScoped;
    if (groupScoped) {
      const entity = await prisma.entity.findUnique({ where: { id: req.admin!.entityId } });
      if (!entity?.groupId) throw new HttpError(400, "Votre établissement n'appartient à aucun groupe");
    }

    const row = await prisma.adminUser.update({
      where: { id: b.id },
      data: {
        name: b.name !== undefined ? b.name.trim() || null : undefined,
        role: b.role,
        active: b.active,
        groupScoped,
      },
    });
    res.json(shapeUser(row));
  })
);

/** POST /wa/hotelUser/resetPassword — body: { id }. */
hotelUserRouter.post(
  "/hotelUser/resetPassword",
  requireAdmin,
  requireHotelAdmin,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.adminUser.findFirst({ where: { id, entityId: req.admin!.entityId } });
    if (!existing) throw new HttpError(404, "Utilisateur introuvable");
    const password = randomPassword();
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.adminUser.update({ where: { id }, data: { passwordHash } });
    res.json({ ok: true, password });
  })
);

/** POST /wa/hotelUser/delete — body: { id }. Révoque l'accès. */
hotelUserRouter.post(
  "/hotelUser/delete",
  requireAdmin,
  requireHotelAdmin,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.adminUser.findFirst({ where: { id, entityId: req.admin!.entityId } });
    if (!existing) throw new HttpError(404, "Utilisateur introuvable");
    if (existing.id === req.admin!.adminId) throw new HttpError(400, "Vous ne pouvez pas supprimer votre propre compte");
    await prisma.adminUser.delete({ where: { id } });
    res.json({ ok: true });
  })
);
