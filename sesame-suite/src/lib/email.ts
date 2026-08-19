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

function fromHeader(
  smtp: { fromName: string | null; fromEmail: string },
  fromNameOverride?: string,
  fromEmailOverride?: string
) {
  const name = fromNameOverride || smtp.fromName;
  const email = fromEmailOverride || smtp.fromEmail;
  return name ? `"${name.replace(/"/g, "")}" <${email}>` : email;
}

/**
 * data:<mime>;base64,<data> → pièce jointe nodemailer — même convention que
 * Room.photos/CrmTicketMessage.attachments (data URI stockée telle quelle en
 * base). Un fichier qui n'est pas une data URI valide est ignoré plutôt que
 * de faire échouer tout l'envoi.
 */
function decodeDataUriAttachment(dataUri: string, index: number): { filename: string; content: Buffer } | null {
  const m = /^data:(image\/(\w+));base64,(.+)$/.exec(dataUri);
  if (!m) return null;
  return { filename: `piece-jointe-${index + 1}.${m[2] === "jpeg" ? "jpg" : m[2]}`, content: Buffer.from(m[3], "base64") };
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

/**
 * PostgreSQL ne garantit pas l'unicité entre plusieurs lignes entityId=NULL
 * (portée CRM globale) : un double-clic sur "Enregistrer", ou deux requêtes
 * concurrentes, peuvent créer deux lignes de config avant que la première
 * ne soit visible du find-then-create. Sans ORDER BY, une lecture peut alors
 * renvoyer une ligne différente de celle qui vient d'être mise à jour — la
 * config semble "ne pas s'enregistrer". orderBy: updatedAt desc rend la
 * lecture déterministe (toujours la plus récente), et upsertSmtpConfig
 * nettoie les doublons dès la prochaine sauvegarde pour repasser à une
 * seule ligne.
 */
export async function getSmtpConfig(entityId: string | null) {
  return prisma.smtpConfig.findFirst({ where: { entityId }, orderBy: { updatedAt: "desc" } });
}

export async function upsertSmtpConfig(
  entityId: string | null,
  data: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
    fromName?: string;
    fromEmail: string;
    supportFromName?: string;
    supportFromEmail?: string;
  }
) {
  const existingRows = await prisma.smtpConfig.findMany({ where: { entityId }, orderBy: { updatedAt: "desc" } });
  if (existingRows.length > 0) {
    const [primary, ...duplicates] = existingRows;
    if (duplicates.length) {
      await prisma.smtpConfig.deleteMany({ where: { id: { in: duplicates.map((d) => d.id) } } });
    }
    return prisma.smtpConfig.update({ where: { id: primary.id }, data });
  }
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

/**
 * Envoi brut, appelé par messaging.ts après rendu du modèle. `fromNameOverride`
 * permet à une règle d'automatisation d'afficher un nom d'expéditeur différent
 * de celui de la config SMTP (ex: "Réception Hôtel Churchill" pour une règle,
 * "Sesame Technology" pour une autre) sans multiplier les configurations SMTP.
 */
export async function sendEmailRaw(
  entityId: string | null,
  to: string,
  subject: string,
  html: string,
  fromNameOverride?: string,
  opts?: { fromEmailOverride?: string; attachments?: string[] }
) {
  const smtp = await getSmtpConfig(entityId);
  if (!smtp) throw new HttpError(400, "Aucun serveur SMTP configuré pour cette portée");
  const transporter = buildTransporter(smtp);
  const attachments = (opts?.attachments || [])
    .map((a, i) => decodeDataUriAttachment(a, i))
    .filter((a): a is { filename: string; content: Buffer } => a !== null);
  try {
    await transporter.sendMail({
      from: fromHeader(smtp, fromNameOverride, opts?.fromEmailOverride),
      to,
      subject,
      html,
      attachments: attachments.length ? attachments : undefined,
    });
  } catch (err) {
    throw new HttpError(502, "Échec de connexion au serveur SMTP : " + smtpErrorMessage(err));
  }
}
