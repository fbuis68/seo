import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { signAdminToken } from "../lib/adminAuth";
import { asyncHandler, HttpError } from "../lib/asyncHandler";

export const loginRouter = Router();

/**
 * POST /wa/login/login
 * body: { email, password }
 *
 * Authentification back-office — endpoint nommé conformément à la
 * documentation technique (§7.1 "Endpoints existants utilisés").
 */
loginRouter.post(
  "/login/login",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const email = ((req.body.email as string) || "").trim().toLowerCase();
    const password = (req.body.password as string) || "";
    if (!email || !password) throw new HttpError(400, "Email et mot de passe requis");

    const admin = await prisma.adminUser.findUnique({
      where: { entityId_email: { entityId: entity.id, email } },
    });
    if (!admin) throw new HttpError(401, "Identifiants incorrects");

    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok) throw new HttpError(401, "Identifiants incorrects");

    const token = signAdminToken({ entityId: entity.id, adminId: admin.id, email: admin.email, role: "admin" });
    res.json({ token, admin: { email: admin.email, name: admin.name || "" } });
  })
);
