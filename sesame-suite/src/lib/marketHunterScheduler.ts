import { prisma } from "../db";
import { MARCHES, MARCHE_DEFS, huntAndQualifyMarket } from "./marketHunter";

/**
 * Boucle de fond — Agent Market Hunter (cahier des charges Sesame AI
 * Autonomous Prospecting, 30/10/2026). Quotas HEBDOMADAIRES (P1-11,
 * 30/12/8) mais passage QUOTIDIEN par petits lots (même principe que
 * marketIntelligenceScheduler.ts) : étale le coût de recherche web sur la
 * semaine plutôt qu'un unique passage massif, et s'arrête dès qu'un marché
 * a atteint son quota de la semaine en cours.
 */
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const BATCH_PER_MARKET_PER_RUN = 6; // plafond de candidats recherchés par marché et par passage

function startOfIsoWeek(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7; // lundi = 0
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return start;
}

async function runScan() {
  const cfg = await prisma.prospectingConfig.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
  if (cfg.emergencyStopped) {
    console.log("[marketHunterScheduler] arrêt d'urgence actif — passage ignoré");
    return;
  }

  const quotas: Record<string, number> = { hotel: cfg.quotaHotel, padel: cfg.quotaPadel, residence: cfg.quotaResidence };
  const weekStart = startOfIsoWeek(new Date());

  for (const marche of MARCHES) {
    const def = MARCHE_DEFS[marche];
    const quota = quotas[marche] || 0;
    if (quota <= 0) continue;

    const qualifiedThisWeek = await prisma.crmProspect.count({
      where: { secteur: def.secteur, origine: "Market Hunter IA", createdAt: { gte: weekStart } },
    });
    const remaining = quota - qualifiedThisWeek;
    if (remaining <= 0) continue;

    const job = await prisma.discoveryJob.create({ data: { marche, status: "running", startedAt: new Date() } });
    try {
      const limit = Math.min(BATCH_PER_MARKET_PER_RUN, remaining);
      const result = await huntAndQualifyMarket(marche, limit);
      await prisma.discoveryJob.update({
        where: { id: job.id },
        data: { status: "done", finishedAt: new Date(), foundCount: result.found, qualifiedCount: result.qualified, excludedCount: result.excluded },
      });
      console.log(`[marketHunterScheduler] ${def.label} : ${result.found} trouvé(s), ${result.qualified} qualifié(s), ${result.excluded} exclu(s)`);
    } catch (e) {
      await prisma.discoveryJob.update({
        where: { id: job.id },
        data: { status: "error", finishedAt: new Date(), errorMessage: e instanceof Error ? e.message : String(e) },
      }).catch(() => {});
      console.error(`[marketHunterScheduler] marché ${marche} échoué:`, e);
    }
  }
}

export function startMarketHunterScheduler() {
  // Premier passage immédiat au démarrage, puis toutes les 24h — même
  // correction que marketIntelligenceScheduler.ts (setInterval ne tire
  // jamais au démarrage, seulement après le premier délai complet).
  runScan().catch((e) => console.error("[marketHunterScheduler] premier passage échoué:", e));
  setInterval(() => {
    runScan().catch((e) => console.error("[marketHunterScheduler] passage échoué:", e));
  }, CHECK_INTERVAL_MS);
  console.log("[marketHunterScheduler] démarré (premier passage immédiat, puis toutes les 24h, quotas hebdomadaires)");
}

export { runScan as runMarketHunterScanNow };
