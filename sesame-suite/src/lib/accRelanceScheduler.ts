import { prisma } from "../db";
import { runRelanceRule } from "./accRelance";

// Quotidien : une relance de facture n'a pas besoin d'être temps réel, et
// runRelanceRule() est auto-réparant (cf. son commentaire — "<=" plutôt
// qu'un match exact du jour) si un passage est manqué, inutile de balayer
// plus souvent.
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * Boucle de fond — toutes les 24h, balaie chaque AccRelanceRule active et
 * envoie les relances dues. Une règle en échec n'interrompt jamais les
 * autres.
 */
export function startAccRelanceScheduler() {
  setInterval(async () => {
    let rules;
    try {
      rules = await prisma.accRelanceRule.findMany({ where: { active: true }, select: { id: true, name: true } });
    } catch (e) {
      console.error("[accRelanceScheduler] check failed:", e);
      return;
    }
    for (const rule of rules) {
      try {
        const summary = await runRelanceRule(rule.id);
        if (summary.results.length) {
          console.log(`[accRelanceScheduler] règle "${rule.name}" : ${summary.successCount} envoyée(s), ${summary.failureCount} échec(s)`);
        }
      } catch (e) {
        console.error(`[accRelanceScheduler] règle "${rule.name}" échouée:`, e);
      }
    }
  }, CHECK_INTERVAL_MS);
  console.log("[accRelanceScheduler] démarré (vérification toutes les 24h)");
}
