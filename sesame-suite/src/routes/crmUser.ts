import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame, requireCrmAdmin } from "../middleware/requireAdmin";
import { randomPassword, validatePasswordPolicy } from "../lib/password";

/**
 * Gestion des utilisateurs CRM (18/08/2026) — les comptes de l'équipe
 * Sesame elle-même (role="sesame", rattachés à l'entité technique
 * "SESAME-HQ"), à ne pas confondre avec adminUser.ts qui gère les comptes
 * admin des CLIENTS (rattachés à leur propre établissement). Réservé aux
 * comptes CRM ayant crmRole="admin" (requireCrmAdmin).
 */
export const crmUserRouter = Router();

const CRM_ROLES = ["admin", "commercial"];

// Data URL base64 (même convention que CrmProspect.logo) — 2 Mo en clair
// largement suffisant pour une photo de profil déjà redimensionnée côté
// navigateur avant envoi, évite qu'un fichier non compressé gonfle la ligne
// AdminUser indéfiniment.
const PHOTO_MAX_BASE64_CHARS = 2 * 1024 * 1024;
function parsePhotoUrl(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  const v = String(raw || "").trim();
  if (!v) return null;
  if (!/^data:image\//.test(v)) throw new HttpError(400, "Photo invalide (format attendu : image)");
  if (v.length > PHOTO_MAX_BASE64_CHARS) throw new HttpError(400, "Photo trop volumineuse");
  return v;
}

function shapeCrmUser(u: {
  id: string;
  email: string;
  name: string | null;
  crmRole: string;
  active: boolean;
  altEmails: string[];
  bookingUrl: string | null;
  phone: string | null;
  photoUrl: string | null;
  createdAt: Date;
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name || "",
    crmRole: u.crmRole,
    active: u.active,
    altEmails: u.altEmails,
    bookingUrl: u.bookingUrl || "",
    phone: u.phone || "",
    photoUrl: u.photoUrl || "",
    createdAt: u.createdAt,
  };
}

function parseAltEmails(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const e of raw) {
    const v = String(e || "").trim().toLowerCase();
    if (v) seen.add(v);
  }
  return [...seen];
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
  password?: string;
  altEmails?: string[];
  bookingUrl?: string;
  phone?: string;
  photoUrl?: string;
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
    if (b.password) {
      const policyError = validatePasswordPolicy(b.password);
      if (policyError) throw new HttpError(400, policyError);
    }
    const password = b.password || randomPassword();
    const passwordHash = await bcrypt.hash(password, 10);
    const row = await prisma.adminUser.create({
      data: {
        entityId: sesameHq.id,
        email,
        name: b.name?.trim() || null,
        role: "sesame",
        crmRole,
        passwordHash,
        altEmails: parseAltEmails(b.altEmails),
        bookingUrl: b.bookingUrl?.trim() || null,
        phone: b.phone?.trim() || null,
        photoUrl: parsePhotoUrl(b.photoUrl) || null,
      },
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
  altEmails?: string[];
  bookingUrl?: string;
  phone?: string;
  photoUrl?: string;
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
        altEmails: b.altEmails !== undefined ? parseAltEmails(b.altEmails) : undefined,
        bookingUrl: b.bookingUrl !== undefined ? b.bookingUrl.trim() || null : undefined,
        phone: b.phone !== undefined ? b.phone.trim() || null : undefined,
        photoUrl: parsePhotoUrl(b.photoUrl),
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
    const bodyPassword = (req.body.password as string) || "";
    const existing = await prisma.adminUser.findUnique({ where: { id } });
    if (!existing || existing.role !== "sesame") throw new HttpError(404, "Utilisateur CRM introuvable");
    if (bodyPassword) {
      const policyError = validatePasswordPolicy(bodyPassword);
      if (policyError) throw new HttpError(400, policyError);
    }
    const password = bodyPassword || randomPassword();
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.adminUser.update({ where: { id }, data: { passwordHash } });
    res.json({ ok: true, password });
  })
);
