import { prisma } from "../db";
import { HttpError } from "./asyncHandler";

export type Channel = "email" | "sms" | "whatsapp";

export function isChannel(v: unknown): v is Channel {
  return v === "email" || v === "sms" || v === "whatsapp";
}

// Fonction du message — sert à filtrer les modèles selon le contexte
// d'utilisation (cf. commentaire sur MessageTemplate.category dans le
// schéma). "" (chaîne vide, envoyée par le front pour "non catégorisé")
// est toujours acceptée et stockée comme null.
export const TEMPLATE_CATEGORIES = ["marketing", "support", "commercial"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export function isTemplateCategory(v: unknown): v is TemplateCategory {
  return typeof v === "string" && (TEMPLATE_CATEGORIES as readonly string[]).includes(v);
}

export async function listMessageTemplates(entityId: string | null, channel?: Channel) {
  return prisma.messageTemplate.findMany({
    where: { entityId, ...(channel ? { channel } : {}) },
    orderBy: { name: "asc" },
  });
}

// Voir le commentaire équivalent dans src/lib/email.ts : PostgreSQL ne
// garantit pas l'unicité entre lignes entityId=NULL (portée CRM globale),
// même sous une contrainte @@unique composite — donc find-then-create doit
// nettoyer les doublons éventuels plutôt que risquer d'en créer un de plus.
export async function upsertMessageTemplate(
  entityId: string | null,
  channel: Channel,
  key: string,
  data: { name: string; subject: string; bodyHtml: string; whatsappContentSid?: string; category?: TemplateCategory | null }
) {
  if (!key || !/^[a-z0-9-]+$/.test(key)) throw new HttpError(400, "Clé de modèle invalide (minuscules, chiffres, tirets)");
  const existingRows = await prisma.messageTemplate.findMany({ where: { entityId, channel, key }, orderBy: { updatedAt: "desc" } });
  if (existingRows.length > 0) {
    const [primary, ...duplicates] = existingRows;
    if (duplicates.length) {
      await prisma.messageTemplate.deleteMany({ where: { id: { in: duplicates.map((d) => d.id) } } });
    }
    return prisma.messageTemplate.update({ where: { id: primary.id }, data });
  }
  return prisma.messageTemplate.create({ data: { entityId, channel, key, ...data } });
}

export async function deleteMessageTemplate(entityId: string | null, id: string) {
  const existing = await prisma.messageTemplate.findFirst({ where: { id, entityId } });
  if (!existing) throw new HttpError(404, "Modèle introuvable");
  await prisma.messageTemplate.delete({ where: { id } });
}
