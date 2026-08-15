import { prisma } from "../db";
import { HttpError } from "./asyncHandler";

export type Channel = "email" | "sms" | "whatsapp";

export async function listMessageTemplates(entityId: string | null, channel?: Channel) {
  return prisma.messageTemplate.findMany({
    where: { entityId, ...(channel ? { channel } : {}) },
    orderBy: { name: "asc" },
  });
}

export async function upsertMessageTemplate(
  entityId: string | null,
  channel: Channel,
  key: string,
  data: { name: string; subject: string; bodyHtml: string }
) {
  if (!key || !/^[a-z0-9-]+$/.test(key)) throw new HttpError(400, "Clé de modèle invalide (minuscules, chiffres, tirets)");
  const existing = await prisma.messageTemplate.findFirst({ where: { entityId, channel, key } });
  if (existing) return prisma.messageTemplate.update({ where: { id: existing.id }, data });
  return prisma.messageTemplate.create({ data: { entityId, channel, key, ...data } });
}

export async function deleteMessageTemplate(entityId: string | null, id: string) {
  const existing = await prisma.messageTemplate.findFirst({ where: { id, entityId } });
  if (!existing) throw new HttpError(404, "Modèle introuvable");
  await prisma.messageTemplate.delete({ where: { id } });
}
