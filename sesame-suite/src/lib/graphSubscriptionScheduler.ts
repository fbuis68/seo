import { renewGraphSubscriptionIfNeeded } from "../routes/graphMail";

/**
 * Balayage périodique du renouvellement de l'abonnement Microsoft Graph —
 * un abonnement sur la ressource "message" expire au plus tard ~2,9 jours
 * après sa création (limite imposée par Graph, pas un choix de ce projet),
 * donc un intervalle d'une heure laisse largement le temps de renouveler
 * avant l'échéance même en cas d'échec ponctuel (retry au tick suivant).
 */
const CHECK_INTERVAL_MS = 60 * 60_000;
let running = false;

export function startGraphSubscriptionScheduler() {
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await renewGraphSubscriptionIfNeeded();
    } catch (e) {
      console.error("[graphSubscriptionScheduler] erreur:", e);
    } finally {
      running = false;
    }
  }, CHECK_INTERVAL_MS);
  console.log(`[graphSubscriptionScheduler] démarré (vérification toutes les ${CHECK_INTERVAL_MS / 60_000} min)`);
}
