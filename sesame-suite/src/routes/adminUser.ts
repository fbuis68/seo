import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { randomPassword } from "../lib/password";

/**
 * Gestion des accès admin rattachés à un contact CRM — la fiche CrmProspect
 * reste la source de vérité de "qui est ce client", ces routes se
 * contentent de créer/révoquer le compte AdminUser correspondant sur
 * l'établissement (Entity) déjà provisionné pour ce contact. Réservé aux
 * comptes Sesame : accorder un accès back-office est un acte sensible.
 */
export const adminUserRouter = Router();

function shapeUser(u: { id: string; email: string; name: string | null; role: string; createdAt: Date }) {
  return { id: u.id, email: u.email, name: u.name || "", role: u.role, createdAt: u.createdAt };
}

/**
 * GET /wa/adminUser/status?entityId=&email=
 * Utilisé par la fiche CRM pour savoir si ce contact a déjà un accès admin
 * sur l'établissement qui lui est rattaché, avant d'afficher "Créer un
 * accès" ou "Compte actif".
 */
/**
 * GET /wa/commercial/list — comptes Sesame (role="sesame") pouvant être
 * désignés comme commercial responsable d'une fiche/affaire CRM (module
 * "Gestion des affaires", 18/08/2026).
 */
adminUserRouter.get(
  "/commercial/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.adminUser.findMany({
      where: { role: "sesame" },
      orderBy: { name: "asc" },
      select: { id: true, email: true, name: true },
    });
    res.json(rows.map((u) => ({ id: u.id, email: u.email, name: u.name || u.email })));
  })
);

adminUserRouter.get(
  "/adminUser/status",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const entityId = (req.query.entityId as string) || "";
    const email = ((req.query.email as string) || "").trim().toLowerCase();
    if (!entityId || !email) throw new HttpError(400, "entityId et email requis");
    const user = await prisma.adminUser.findFirst({ where: { entityId, email } });
    res.json(user ? { exists: true, user: shapeUser(user) } : { exists: false });
  })
);

interface CreateBody {
  entityId: string;
  email: string;
  name?: string;
  role?: string;
}

/** POST /wa/adminUser/create — provisionne un compte admin pour un contact
 * CRM déjà rattaché à un établissement (CrmProspect.entityId non nul).
 * Le mot de passe généré n'est retourné qu'une fois, en clair. */
adminUserRouter.post(
  "/adminUser/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as CreateBody;
    const email = (b.email || "").trim().toLowerCase();
    if (!b.entityId) throw new HttpError(400, "Aucun établissement rattaché à ce contact");
    if (!email) throw new HttpError(400, "Ce contact n'a pas d'adresse email");
    const role = b.role === "sesame" ? "sesame" : "hotel";

    const entity = await prisma.entity.findUnique({ where: { id: b.entityId } });
    if (!entity) throw new HttpError(404, "Établissement introuvable");

    const existing = await prisma.adminUser.findUnique({ where: { email } });
    if (existing) throw new HttpError(409, `Un compte admin existe déjà avec l'email ${email}`);

    const password = randomPassword();
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.adminUser.create({
      data: { entityId: b.entityId, email, name: b.name?.trim() || null, passwordHash, role },
    });
    res.status(201).json({ ...shapeUser(user), password });
  })
);

/** POST /wa/adminUser/resetPassword — body: { id }. Régénère un mot de
 * passe temporaire, retourné une seule fois en clair. */
adminUserRouter.post(
  "/adminUser/resetPassword",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const user = await prisma.adminUser.findUnique({ where: { id } });
    if (!user) throw new HttpError(404, "Compte introuvable");
    const password = randomPassword();
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.adminUser.update({ where: { id }, data: { passwordHash } });
    res.json({ ok: true, password });
  })
);

/** POST /wa/adminUser/delete — body: { id }. Révoque l'accès admin. */
adminUserRouter.post(
  "/adminUser/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const user = await prisma.adminUser.findUnique({ where: { id } });
    if (!user) throw new HttpError(404, "Compte introuvable");
    await prisma.adminUser.delete({ where: { id } });
    res.json({ ok: true });
  })
);
