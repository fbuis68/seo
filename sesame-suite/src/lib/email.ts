import nodemailer from "nodemailer";
import { prisma } from "../db";
import { HttpError } from "./asyncHandler";

/**
 * Canal email — config SMTP + envoi brut. Le rendu de modèle et le choix du
 * canal (email/sms/whatsapp) sont gérés en amont par src/lib/messaging.ts ;
 * ce module ne connaît que l'envoi SMTP proprement dit.
 */

function buildTransporter(smtp: { host: string; port: number; secure: boolean; username: string; password: string }) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.username, pass: smtp.password },
  });
}

function fromHeader(smtp: { fromName: string | null; fromEmail: string }) {
  return smtp.fromName ? `"${smtp.fromName.replace(/"/g, "")}" <${smtp.fromEmail}>` : smtp.fromEmail;
}

/**
 * nodemailer rejette avec une Error brute (ETIMEDOUT, ECONNREFUSED, EAUTH,
 * certificat invalide…) qui, non interceptée, remonte telle quelle jusqu'à
 * errorHandler : comme ce n'est pas une HttpError, elle est aplatie en 500
 * générique ("Erreur interne du serveur") — aucune information exploitable
 * ne parvient à l'utilisateur pour diagnostiquer sa configuration SMTP. On
 * la reconvertit ici en HttpError pour que le message réel (hôte, port,
 * identifiants, TLS…) s'affiche dans l'interface.
 */
function smtpErrorMessage(err: unknown): string {
  const e = err as { code?: string; message?: string; command?: string } | undefined;
  const parts = [e?.code, e?.message].filter(Boolean);
  return parts.length ? parts.join(" — ") : String(err);
}

export async function getSmtpConfig(entityId: string | null) {
  return prisma.smtpConfig.findFirst({ where: { entityId } });
}

export async function upsertSmtpConfig(
  entityId: string | null,
  data: { host: string; port: number; secure: boolean; username: string; password: string; fromName?: string; fromEmail: string }
) {
  const existing = await prisma.smtpConfig.findFirst({ where: { entityId } });
  if (existing) return prisma.smtpConfig.update({ where: { id: existing.id }, data });
  return prisma.smtpConfig.create({ data: { entityId, ...data } });
}

export async function sendTestEmail(entityId: string | null, to: string) {
  const smtp = await getSmtpConfig(entityId);
  if (!smtp) throw new HttpError(400, "Aucun serveur SMTP configuré pour cette portée");
  const transporter = buildTransporter(smtp);
  try {
    await transporter.sendMail({
      from: fromHeader(smtp),
      to,
      subject: "Sesame Suite — test de configuration SMTP",
      html: "<p>Ce message confirme que la configuration SMTP fonctionne correctement.</p>",
    });
  } catch (err) {
    throw new HttpError(502, "Échec de connexion au serveur SMTP : " + smtpErrorMessage(err));
  }
}

/** Envoi brut, appelé par messaging.ts après rendu du modèle. */
export async function sendEmailRaw(entityId: string | null, to: string, subject: string, html: string) {
  const smtp = await getSmtpConfig(entityId);
  if (!smtp) throw new HttpError(400, "Aucun serveur SMTP configuré pour cette portée");
  const transporter = buildTransporter(smtp);
  try {
    await transporter.sendMail({ from: fromHeader(smtp), to, subject, html });
  } catch (err) {
    throw new HttpError(502, "Échec de connexion au serveur SMTP : " + smtpErrorMessage(err));
  }
}
