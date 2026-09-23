import { prisma } from "../db";
import { syncScaleway } from "./scaleway";

// Les factures Scaleway ne changent pas en cours de mois (nouvelle
// facture ~1x/mois) — pas besoin d'un intervalle court comme Qonto/
// GoCardless (transactions bancaires). Vérification quotidienne, même
// cadence que accRelanceScheduler.ts.
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const inFlight = new Set<string>();

/**
 * Boucle de fond — une fois par jour, resynchronise chaque organisation
 * ayant configuré Scaleway (une ligne ScalewayConfig par entityId,
 * entityId=null pour la portée globale Sesame — même convention que
 * GoCardlessConfig, cf. lib/gocardlessScheduler.ts).
 */
export function startScalewayScheduler() {
  setInterval(async () => {
    let configs;
    try {
      configs = await prisma.scalewayConfig.findMany({ select: { id: true, entityId: true } });
    } catch (e) {
      console.error("[scalewayScheduler] check failed:", e);
      return;
    }

    for (const config of configs) {
      if (inFlight.has(config.id)) continue;
      inFlight.add(config.id);
      syncScaleway(config.entityId)
        .catch((e) => console.error(`[scalewayScheduler] sync failed for config ${config.id}:`, e))
        .finally(() => inFlight.delete(config.id));
    }
  }, CHECK_INTERVAL_MS);
  console.log("[scalewayScheduler] démarré (vérification quotidienne)");
}
