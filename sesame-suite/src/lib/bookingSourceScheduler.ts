import { prisma } from "../db";
import { runImport } from "./bookingSource";

const CHECK_INTERVAL_MS = 60_000;
const inFlight = new Set<string>();

/**
 * Boucle de fond — vérifiée toutes les minutes, déclenche runImport() pour
 * chaque établissement dont le connecteur est actif et dont l'intervalle de
 * synchronisation configuré (syncIntervalMinutes) est écoulé depuis
 * lastSyncAt. syncIntervalMinutes=null => synchronisation manuelle
 * uniquement, jamais touché ici.
 */
export function startBookingSourceScheduler() {
  setInterval(async () => {
    let configs;
    try {
      configs = await prisma.bookingSourceConfig.findMany({
        where: { enabled: true, syncIntervalMinutes: { not: null } },
        include: { entity: true },
      });
    } catch (e) {
      console.error("[bookingSourceScheduler] check failed:", e);
      return;
    }

    const now = Date.now();
    for (const config of configs) {
      if (inFlight.has(config.entityId)) continue;
      const dueAt = config.lastSyncAt ? config.lastSyncAt.getTime() + config.syncIntervalMinutes! * 60_000 : 0;
      if (now < dueAt) continue;

      inFlight.add(config.entityId);
      runImport(config.entity, config)
        .catch((e) => console.error(`[bookingSourceScheduler] import failed for ${config.entity.code}:`, e))
        .finally(() => inFlight.delete(config.entityId));
    }
  }, CHECK_INTERVAL_MS);
  console.log("[bookingSourceScheduler] démarré (vérification toutes les 60s)");
}
