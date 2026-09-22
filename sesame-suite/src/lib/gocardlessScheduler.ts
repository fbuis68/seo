import { prisma } from "../db";
import { syncGoCardless } from "./gocardless";

// Même intervalle que qontoScheduler.ts (15 min) — pas de besoin de
// temps réel sur une synchro bancaire, et l'API GoCardless applique
// elle aussi un rate-limit par compte.
const CHECK_INTERVAL_MS = 15 * 60_000;
const inFlight = new Set<string>();

/**
 * Boucle de fond — toutes les 15 min, resynchronise chaque organisation
 * ayant configuré GoCardless (une ligne GoCardlessConfig par entityId,
 * entityId=null pour la portée globale Sesame — cf. lib/gocardless.ts).
 * Contrairement à Qonto (un compte bancaire = une clé d'entité stable),
 * GoCardlessConfig.entityId peut être null : `inFlight` est donc indexé
 * sur config.id, pas entityId.
 */
export function startGoCardlessScheduler() {
  setInterval(async () => {
    let configs;
    try {
      configs = await prisma.goCardlessConfig.findMany({ select: { id: true, entityId: true } });
    } catch (e) {
      console.error("[gocardlessScheduler] check failed:", e);
      return;
    }

    for (const config of configs) {
      if (inFlight.has(config.id)) continue;
      inFlight.add(config.id);
      syncGoCardless(config.entityId)
        .catch((e) => console.error(`[gocardlessScheduler] sync failed for config ${config.id}:`, e))
        .finally(() => inFlight.delete(config.id));
    }
  }, CHECK_INTERVAL_MS);
  console.log("[gocardlessScheduler] démarré (vérification toutes les 15 min)");
}
