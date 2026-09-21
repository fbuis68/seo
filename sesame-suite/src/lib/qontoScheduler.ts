import { prisma } from "../db";
import { syncQontoBankAccount } from "./qonto";

// 15 min : une synchro bancaire n'a pas besoin d'être temps réel (contrairement
// aux connecteurs PMS/serrure), et Qonto applique un rate-limit par
// organisation — pas d'intérêt à interroger plus souvent.
const CHECK_INTERVAL_MS = 15 * 60_000;
const inFlight = new Set<string>();

/**
 * Boucle de fond — toutes les 15 min, resynchronise chaque AccBankAccount
 * lié à Qonto (provider="qonto") dont la connexion n'est pas en erreur.
 * Un compte en connectionStatus="error" n'est plus retenté automatiquement
 * (évite de marteler l'API avec des identifiants invalides) — reprise via
 * "Synchroniser maintenant" côté UI, qui remet le statut à jour.
 */
export function startQontoScheduler() {
  setInterval(async () => {
    let accounts;
    try {
      accounts = await prisma.accBankAccount.findMany({
        where: { provider: "qonto", connectionStatus: { not: "error" } },
        select: { id: true },
      });
    } catch (e) {
      console.error("[qontoScheduler] check failed:", e);
      return;
    }

    for (const account of accounts) {
      if (inFlight.has(account.id)) continue;
      inFlight.add(account.id);
      syncQontoBankAccount(account.id)
        .catch((e) => console.error(`[qontoScheduler] sync failed for ${account.id}:`, e))
        .finally(() => inFlight.delete(account.id));
    }
  }, CHECK_INTERVAL_MS);
  console.log("[qontoScheduler] démarré (vérification toutes les 15 min)");
}
