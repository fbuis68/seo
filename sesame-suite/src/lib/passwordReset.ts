import crypto from "node:crypto";
import { prisma } from "../db";

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1h

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Génère un token de réinitialisation — seul son hash est stocké en base
 * (comme un mot de passe), le token en clair ne transite que dans l'email
 * envoyé et ne peut donc pas être reconstitué depuis une fuite de la base.
 */
export async function createResetToken(adminUserId: string): Promise<string> {
  const raw = crypto.randomBytes(32).toString("hex");
  await prisma.passwordResetToken.create({
    data: { adminUserId, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
  });
  return raw;
}

/**
 * Valide et consomme un token à usage unique (marqué utilisé immédiatement,
 * pour empêcher un rejeu même si le lien a été intercepté). Retourne l'id
 * du compte si le token est valide (existant, non expiré, non déjà
 * utilisé), sinon null.
 */
export async function consumeResetToken(rawToken: string): Promise<string | null> {
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) return null;
  await prisma.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
  return row.adminUserId;
}
