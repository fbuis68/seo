import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../db";
import { signAdminToken, AdminRole } from "../lib/adminAuth";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { createResetToken, consumeResetToken } from "../lib/passwordReset";
import { sendEmailRaw } from "../lib/email";

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
    // Message générique (pas "compte désactivé") : un compte désactivé ne
    // doit pas se distinguer d'un mauvais mot de passe pour un tiers.
    if (!admin.active) throw new HttpError(401, "Identifiants incorrects");

    const token = signAdminToken({
      entityId: admin.entityId,
      entityCode: admin.entity.code,
      adminId: admin.id,
      email: admin.email,
      role: admin.role as AdminRole,
      crmRole: admin.crmRole,
    });
    res.json({
      token,
      admin: {
        email: admin.email,
        name: admin.name || "",
        role: admin.role,
        crmRole: admin.crmRole,
        entityCode: admin.entity.code,
        hotelName: admin.entity.config?.hotelName || admin.entity.name,
      },
    });
  })
);

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/**
 * L'email de réinitialisation part avec la config SMTP du compte
 * (l'établissement de l'admin, ou la portée CRM globale pour un compte
 * "sesame") — comme partout ailleurs dans l'app. Repli sur la config SMTP
 * globale Sesame si celle-ci échoue (établissement pas encore configuré) :
 * sinon un hôtel sans SMTP configuré n'aurait aucun moyen de récupérer
 * l'accès à la page même qui permettrait de le configurer.
 */
async function sendResetEmail(admin: { entityId: string; role: string; email: string; name: string | null }, resetUrl: string) {
  const subject = "Réinitialisation de votre mot de passe Sesame Suite";
  const html = `<p>Bonjour${admin.name ? " " + escHtml(admin.name) : ""},</p>
    <p>Une demande de réinitialisation de mot de passe a été faite pour ce compte (${escHtml(admin.email)}).</p>
    <p><a href="${resetUrl}">Choisir un nouveau mot de passe</a></p>
    <p>Ce lien expire dans 1 heure. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email — votre mot de passe actuel reste valide.</p>`;
  const primaryEntityId = admin.role === "sesame" ? null : admin.entityId;
  try {
    await sendEmailRaw(primaryEntityId, admin.email, subject, html);
  } catch (err) {
    if (primaryEntityId === null) throw err;
    await sendEmailRaw(null, admin.email, subject, html, "Sesame Technology");
  }
}

/**
 * POST /wa/login/forgotPassword — body: { email }
 * Réponse identique que le compte existe ou non, et même en cas d'échec
 * d'envoi (uniquement journalisé côté serveur) — évite qu'une réponse
 * différente serve à énumérer les comptes existants.
 */
loginRouter.post(
  "/login/forgotPassword",
  asyncHandler(async (req, res) => {
    const email = ((req.body.email as string) || "").trim().toLowerCase();
    if (!email) throw new HttpError(400, "Email requis");

    const admin = await prisma.adminUser.findUnique({ where: { email } });
    if (admin) {
      try {
        const rawToken = await createResetToken(admin.id);
        const proto = req.get("x-forwarded-proto") || req.protocol;
        const host = req.get("host");
        const page = admin.role === "sesame" ? "crm.html" : "admin.html";
        const resetUrl = `${proto}://${host}/${page}?resetToken=${rawToken}`;
        await sendResetEmail(admin, resetUrl);
      } catch (err) {
        console.error(`[password-reset] échec d'envoi pour ${email}:`, err);
      }
    }
    res.json({ ok: true, message: "Si un compte existe avec cette adresse, un email de réinitialisation vient d'être envoyé." });
  })
);

/**
 * POST /wa/login/resetPassword — body: { token, password }
 */
loginRouter.post(
  "/login/resetPassword",
  asyncHandler(async (req, res) => {
    const token = (req.body.token as string) || "";
    const password = (req.body.password as string) || "";
    if (!token) throw new HttpError(400, "Lien de réinitialisation invalide");
    if (password.length < 8) throw new HttpError(400, "Le mot de passe doit contenir au moins 8 caractères");

    const adminUserId = await consumeResetToken(token);
    if (!adminUserId) throw new HttpError(400, "Ce lien de réinitialisation est invalide ou a expiré");

    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.adminUser.update({ where: { id: adminUserId }, data: { passwordHash } });
    res.json({ ok: true });
  })
);
