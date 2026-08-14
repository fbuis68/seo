import nodemailer from "nodemailer";
import { prisma } from "../db";
import { HttpError } from "./asyncHandler";

/**
 * Envoi d'email générique — un seul mécanisme (config SMTP + modèles +
 * rendu de variables) réutilisé à l'identique par le CRM commercial
 * (entityId=null, portée Sesame) et par le back-office de chaque hôtel
 * (entityId=<hôtel>). Les routes (src/routes/email.ts) ne font que
 * résoudre le bon entityId puis appellent ces fonctions.
 */

function renderTemplate(str: string, vars: Record<string, string>): string {
  return str.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => vars[key] ?? "");
}

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

export async function listEmailTemplates(entityId: string | null) {
  return prisma.emailTemplate.findMany({ where: { entityId }, orderBy: { name: "asc" } });
}

export async function upsertEmailTemplate(
  entityId: string | null,
  key: string,
  data: { name: string; subject: string; bodyHtml: string }
) {
  if (!key || !/^[a-z0-9-]+$/.test(key)) throw new HttpError(400, "Clé de modèle invalide (minuscules, chiffres, tirets)");
  const existing = await prisma.emailTemplate.findFirst({ where: { entityId, key } });
  if (existing) return prisma.emailTemplate.update({ where: { id: existing.id }, data });
  return prisma.emailTemplate.create({ data: { entityId, key, ...data } });
}

export async function deleteEmailTemplate(entityId: string | null, id: string) {
  const existing = await prisma.emailTemplate.findFirst({ where: { id, entityId } });
  if (!existing) throw new HttpError(404, "Modèle introuvable");
  await prisma.emailTemplate.delete({ where: { id } });
}

export async function sendTemplatedEmail(opts: {
  entityId: string | null;
  templateKey: string;
  to: string;
  variables?: Record<string, string>;
}) {
  const smtp = await getSmtpConfig(opts.entityId);
  if (!smtp) throw new HttpError(400, "Aucun serveur SMTP configuré pour cette portée");
  const template = await prisma.emailTemplate.findFirst({ where: { entityId: opts.entityId, key: opts.templateKey } });
  if (!template) throw new HttpError(404, "Modèle d'email introuvable");
  const vars = opts.variables || {};
  const subject = renderTemplate(template.subject, vars);
  const html = renderTemplate(template.bodyHtml, vars);
  const transporter = buildTransporter(smtp);
  try {
    await transporter.sendMail({ from: fromHeader(smtp), to: opts.to, subject, html });
  } catch (err) {
    throw new HttpError(502, "Échec de connexion au serveur SMTP : " + smtpErrorMessage(err));
  }
  return { subject, html };
}
