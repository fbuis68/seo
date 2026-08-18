import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame, requireCrmAdmin } from "../middleware/requireAdmin";
import { randomPassword } from "../lib/password";

/**
 * Gestion des utilisateurs CRM (18/08/2026) — les comptes de l'équipe
 * Sesame elle-même (role="sesame", rattachés à l'entité technique
 * "SESAME-HQ"), à ne pas confondre avec adminUser.ts qui gère les comptes
 * admin des CLIENTS (rattachés à leur propre établissement). Réservé aux
 * comptes CRM ayant crmRole="admin" (requireCrmAdmin).
 */
export const crmUserRouter = Router();

const CRM_ROLES = ["admin", "commercial"];

function shapeCrmUser(u: { id: string; email: string; name: string | null; crmRole: string; active: boolean; createdAt: Date }) {
  return { id: u.id, email: u.email, name: u.name || "", crmRole: u.crmRole, active: u.active, createdAt: u.createdAt };
}

crmUserRouter.get(
  "/crmUser/list",
  requireAdmin,
  requireSesame,
  requireCrmAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.adminUser.findMany({ where: { role: "sesame" }, orderBy: { name: "asc" } });
    res.json(rows.map(shapeCrmUser));
  })
);

interface CreateBody {
  email: string;
  name?: string;
  crmRole?: string;
}

crmUserRouter.post(
  "/crmUser/create",
  requireAdmin,
  requireSesame,
  requireCrmAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body as CreateBody;
    const email = (b.email || "").trim().toLowerCase();
    if (!email) throw new HttpError(400, "Email requis");
    const crmRole = CRM_ROLES.includes(b.crmRole || "") ? (b.crmRole as string) : "commercial";
    const existing = await prisma.adminUser.findUnique({ where: { email } });
    if (existing) throw new HttpError(409, "Un compte existe déjà avec cet email");
    const sesameHq = await prisma.entity.findUnique({ where: { code: "SESAME-HQ" } });
    if (!sesameHq) throw new HttpError(500, "Entité Sesame HQ introuvable");
    const password = randomPassword();
    const passwordHash = await bcrypt.hash(password, 10);
    const row = await prisma.adminUser.create({
      data: { entityId: sesameHq.id, email, name: b.name?.trim() || null, role: "sesame", crmRole, passwordHash },
    });
    // Le mot de passe généré n'est retourné qu'une fois, en clair — jamais relu ensuite.
    res.status(201).json({ ...shapeCrmUser(row), password });
  })
);

interface UpdateBody {
  id: string;
  name?: string;
  crmRole?: string;
  active?: boolean;
}

crmUserRouter.post(
  "/crmUser/update",
  requireAdmin,
  requireSesame,
  requireCrmAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body as UpdateBody;
    if (!b.id) throw new HttpError(400, "id requis");
    const existing = await prisma.adminUser.findUnique({ where: { id: b.id } });
    if (!existing || existing.role !== "sesame") throw new HttpError(404, "Utilisateur CRM introuvable");
    if (b.active === false && req.admin && existing.id === req.admin.adminId) {
      throw new HttpError(400, "Vous ne pouvez pas désactiver votre propre compte");
    }
    const crmRole = b.crmRole !== undefined && CRM_ROLES.includes(b.crmRole) ? b.crmRole : undefined;
    const row = await prisma.adminUser.update({
      where: { id: b.id },
      data: {
        name: b.name !== undefined ? b.name.trim() || null : undefined,
        crmRole,
        active: b.active,
      },
    });
    res.json(shapeCrmUser(row));
  })
);

crmUserRouter.post(
  "/crmUser/resetPassword",
  requireAdmin,
  requireSesame,
  requireCrmAdmin,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.adminUser.findUnique({ where: { id } });
    if (!existing || existing.role !== "sesame") throw new HttpError(404, "Utilisateur CRM introuvable");
    const password = randomPassword();
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.adminUser.update({ where: { id }, data: { passwordHash } });
    res.json({ ok: true, password });
  })
);
