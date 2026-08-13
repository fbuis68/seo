import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../db";
import { signAdminToken, AdminRole } from "../lib/adminAuth";
import { asyncHandler, HttpError } from "../lib/asyncHandler";

export const loginRouter = Router();

/**
 * POST /wa/login/login
 * body: { email, password }
 *
 * Authentification back-office — endpoint nommé conformément à la
 * documentation technique (§7.1 "Endpoints existants utilisés"). L'email
 * est unique tous établissements confondus (un compte = un email), donc
 * aucun entityCode n'est requis pour se connecter — le compte porte son
 * propre établissement (ou "Sesame HQ" pour les comptes Sesame).
 */
loginRouter.post(
  "/login/login",
  asyncHandler(async (req, res) => {
    const email = ((req.body.email as string) || "").trim().toLowerCase();
    const password = (req.body.password as string) || "";
    if (!email || !password) throw new HttpError(400, "Email et mot de passe requis");

    const admin = await prisma.adminUser.findUnique({ where: { email }, include: { entity: { include: { config: true } } } });
    if (!admin) throw new HttpError(401, "Identifiants incorrects");

    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok) throw new HttpError(401, "Identifiants incorrects");

    const token = signAdminToken({
      entityId: admin.entityId,
      entityCode: admin.entity.code,
      adminId: admin.id,
      email: admin.email,
      role: admin.role as AdminRole,
    });
    res.json({
      token,
      admin: {
        email: admin.email,
        name: admin.name || "",
        role: admin.role,
        entityCode: admin.entity.code,
        hotelName: admin.entity.config?.hotelName || admin.entity.name,
      },
    });
  })
);
