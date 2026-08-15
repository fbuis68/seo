import { prisma } from "../db";
import { HttpError } from "./asyncHandler";
import { sendEmailRaw } from "./email";
import { sendChannelRaw } from "./sms";
import { Channel } from "./messageTemplate";

/**
 * Point de convergence unique : quel que soit le canal (email/sms/whatsapp),
 * l'appelant (routes/email.ts pour l'envoi manuel, automation.ts pour les
 * règles) passe par sendMessage() — c'est ici, et seulement ici, que le
 * canal est traduit vers le bon transport (SMTP ou Twilio).
 */

function renderTemplate(str: string, vars: Record<string, string>): string {
  return str.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => vars[key] ?? "");
}

export async function sendMessage(opts: {
  entityId: string | null;
  channel: Channel;
  templateKey: string;
  to: string;
  variables?: Record<string, string>;
  /** Email uniquement — nom d'expéditeur affiché, remplace celui de la config SMTP pour cet envoi. */
  fromNameOverride?: string;
}) {
  const template = await prisma.messageTemplate.findFirst({
    where: { entityId: opts.entityId, channel: opts.channel, key: opts.templateKey },
  });
  if (!template) throw new HttpError(404, "Modèle introuvable pour ce canal");

  const vars = opts.variables || {};
  const subject = renderTemplate(template.subject, vars);
  const body = renderTemplate(template.bodyHtml, vars);

  if (opts.channel === "email") {
    await sendEmailRaw(opts.entityId, opts.to, subject, body, opts.fromNameOverride);
  } else {
    await sendChannelRaw(opts.entityId, opts.channel, opts.to, body);
  }
  return { subject, body };
}
