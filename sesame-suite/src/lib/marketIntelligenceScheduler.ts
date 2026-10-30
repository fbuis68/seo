import { prisma } from "../db";
import { config } from "../config";
import { findCompanyNews } from "./aiClaude";

// Quotidien : l'actualité d'une entreprise n'a pas besoin d'être surveillée
// en temps réel. Limité aux prospects avec un commercial assigné (décision
// du 28/10 — pas de scan de masse sur des suspects importés en vrac et non
// triés) et à un lot plafonné par passage pour borner le coût (recherche web
// Anthropic facturée à l'usage, pas un abonnement) — cf. SalesSignal créé
// par ce flux, source="Recherche web (Agent Market Intelligence)".
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const BATCH_SIZE = 20;
const RESCAN_AFTER_DAYS = 14; // une fiche déjà scannée récemment n'est pas re-interrogée à chaque passage

function parsePublishedAt(raw?: string): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

async function scanOneProspect(p: { id: string; nom: string; secteur: string | null }) {
  const items = await findCompanyNews(p.nom, p.secteur || undefined);
  for (const item of items) {
    await prisma.salesSignal.create({
      data: {
        prospectId: p.id,
        companyName: p.nom,
        source: "Recherche web (Agent Market Intelligence)",
        url: item.url,
        signalType: "actualite",
        publishedAt: parsePublishedAt(item.publishedAt),
        confidence: 0.5,
        hypothesis: item.summary,
        status: "to_verify", // généré par l'agent, jamais considéré vérifié d'office — cf. §2 du brief
      },
    });
  }
  // Journal réservé aux passages avec un résultat réel (30/10/2026, demande
  // client "s'il n'y a rien ne pas faire de log") — un scan sans actualité
  // pertinente est le cas normal/majoritaire, pas un événement à tracer.
  if (!items.length) return;
  await prisma.agentDecisionLog.create({
    data: {
      agentName: "market_intelligence",
      prospectId: p.id,
      inputSummary: `Recherche actualité : ${p.nom}${p.secteur ? " (" + p.secteur + ")" : ""}`,
      outputSummary: JSON.stringify(items),
      model: config.anthropicModel,
    },
  });
}

/**
 * Boucle de fond — toutes les 24h, scanne un lot de prospects avec un
 * commercial assigné pour détecter de l'actualité récente (Agent Market
 * Intelligence). Un prospect en échec n'interrompt jamais les autres, et sa
 * date de scan avance quand même (évite de re-tenter en boucle à chaque
 * passage une entreprise dont le nom pose systématiquement problème, ex.
 * ambigu — cf. même principe que syncMeetingHistory).
 */
async function runScan() {
  if (!config.anthropicApiKey) return; // pas de clé configurée — rien à scanner
  let prospects: { id: string; nom: string; secteur: string | null }[];
  try {
    const rescanBefore = new Date(Date.now() - RESCAN_AFTER_DAYS * 24 * 60 * 60_000);
    prospects = await prisma.crmProspect.findMany({
      where: {
        commercialId: { not: null },
        OR: [{ lastSignalScanAt: null }, { lastSignalScanAt: { lt: rescanBefore } }],
      },
      orderBy: [{ lastSignalScanAt: "asc" }],
      take: BATCH_SIZE,
      select: { id: true, nom: true, secteur: true },
    });
  } catch (e) {
    console.error("[marketIntelligenceScheduler] sélection échouée:", e);
    return;
  }
  for (const p of prospects) {
    try {
      await scanOneProspect(p);
    } catch (e) {
      console.error(`[marketIntelligenceScheduler] prospect ${p.id} échoué:`, e);
    } finally {
      await prisma.crmProspect.update({ where: { id: p.id }, data: { lastSignalScanAt: new Date() } }).catch(() => {});
    }
  }
  if (prospects.length) console.log(`[marketIntelligenceScheduler] ${prospects.length} prospect(s) scanné(s)`);
}

export function startMarketIntelligenceScheduler() {
  // setInterval n'exécute JAMAIS au démarrage, seulement après le premier
  // délai complet (24h) — un serveur qui vient d'être déployé n'aurait donc
  // aucune entrée avant le lendemain (cas constaté 30/10/2026, "journal
  // vide, est-ce normal ?"). Un premier passage immédiat comble ce trou.
  runScan().catch((e) => console.error("[marketIntelligenceScheduler] premier passage échoué:", e));
  setInterval(() => {
    runScan().catch((e) => console.error("[marketIntelligenceScheduler] passage échoué:", e));
  }, CHECK_INTERVAL_MS);
  console.log("[marketIntelligenceScheduler] démarré (premier passage immédiat, puis toutes les 24h)");
}
