import { prisma } from "../db";

/**
 * Journal d'audit du module comptable (§46) — écrit à chaque action
 * sensible (validation d'écriture, comptabilisation, correction manuelle
 * d'un champ extrait, création/suppression de règle...). Jamais modifié ni
 * supprimé après coup — cf. AccAuditLog, pas de fonction update/delete ici.
 */
export async function recordAuditLog(entry: {
  entityId: string | null;
  userId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  oldValue?: unknown;
  newValue?: unknown;
  ip?: string | null;
  source?: "api" | "interface";
}): Promise<void> {
  await prisma.accAuditLog.create({
    data: {
      entityId: entry.entityId,
      userId: entry.userId || undefined,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      oldValue: entry.oldValue === undefined ? undefined : (entry.oldValue as object),
      newValue: entry.newValue === undefined ? undefined : (entry.newValue as object),
      ip: entry.ip || undefined,
      source: entry.source || "api",
    },
  });
}
