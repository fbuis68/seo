import { prisma } from "../db";
import { runCatalogImport } from "./lockerSource";

const CHECK_INTERVAL_MS = 60_000;
const inFlight = new Set<string>();

/**
 * Boucle de fond — même principe que bookingSourceScheduler.ts : vérifiée
 * toutes les minutes, déclenche runCatalogImport() pour chaque
 * établissement dont le connecteur Mon Casier Frais est actif et dont
 * l'intervalle configuré (syncIntervalMinutes) est écoulé depuis
 * lastSyncAt. syncIntervalMinutes=null => synchronisation manuelle
 * uniquement, jamais touché ici.
 */
export function startLockerSourceScheduler() {
  setInterval(async () => {
    let configs;
    try {
      configs = await prisma.lockerSourceConfig.findMany({
        where: { enabled: true, syncIntervalMinutes: { not: null } },
        include: { entity: true },
      });
    } catch (e) {
      console.error("[lockerSourceScheduler] check failed:", e);
      return;
    }

    const now = Date.now();
    for (const config of configs) {
      if (inFlight.has(config.entityId)) continue;
      const dueAt = config.lastSyncAt ? config.lastSyncAt.getTime() + config.syncIntervalMinutes! * 60_000 : 0;
      if (now < dueAt) continue;

      inFlight.add(config.entityId);
      runCatalogImport(config.entity, config)
        .catch((e) => console.error(`[lockerSourceScheduler] import failed for ${config.entity.code}:`, e))
        .finally(() => inFlight.delete(config.entityId));
    }
  }, CHECK_INTERVAL_MS);
  console.log("[lockerSourceScheduler] démarré (vérification toutes les 60s)");
}
