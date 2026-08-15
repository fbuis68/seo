import { runAutomationSweep } from "./automation";

const CHECK_INTERVAL_MS = 15 * 60_000; // 15 minutes — largement suffisant pour des rappels/newsletters à l'heure près
let running = false;

/**
 * Boucle de fond pour les règles d'automatisation à déclenchement différé
 * (avant/après séjour) ou récurrent (newsletter) — les règles "immediate"
 * ne passent pas par ici, elles sont déclenchées en synchrone par
 * fireTrigger() depuis les routes métier concernées.
 */
export function startAutomationScheduler() {
  setInterval(async () => {
    if (running) return; // évite le chevauchement si un balayage précédent traîne encore
    running = true;
    try {
      await runAutomationSweep();
    } catch (e) {
      console.error("[automationScheduler] balayage échoué:", e);
    } finally {
      running = false;
    }
  }, CHECK_INTERVAL_MS);
  console.log("[automationScheduler] démarré (vérification toutes les 15 min)");
}
