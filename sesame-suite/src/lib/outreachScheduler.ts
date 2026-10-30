import { prisma } from "../db";
import { scheduleFirstContacts, scheduleRelances } from "./outreach";

/**
 * Boucle de fond — P2-01 (premiers emails pour les prospects qualifiés par
 * le Market Hunter) + P2-06 (relances J+4/J+10/J+20). Ne fait QUE générer
 * des brouillons "pending_approval" — jamais d'envoi automatique (aucun
 * appel à sendDraft() ici, cf. §5 du brief "0 email envoyé sans
 * approbation"). Respecte l'arrêt d'urgence global (ProspectingConfig),
 * même garde-fou que marketHunterScheduler.ts.
 */
const CHECK_INTERVAL_MS = 6 * 60 * 60_000; // toutes les 6h — pas de coût web associé ici (pas d'appel de recherche), cadence plus rapprochée que le Market Hunter

async function runScan() {
  const cfg = await prisma.prospectingConfig.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  if (cfg.emergencyStopped) {
    console.log("[outreachScheduler] arrêt d'urgence actif — passage ignoré");
    return;
  }
  try {
    const firstContacts = await scheduleFirstContacts();
    const relances = await scheduleRelances();
    if (firstContacts || relances) console.log(`[outreachScheduler] ${firstContacts} premier(s) email(s), ${relances} relance(s) générés (en attente de validation)`);
  } catch (e) {
    console.error("[outreachScheduler] passage échoué:", e);
  }
}

export function startOutreachScheduler() {
  runScan().catch((e) => console.error("[outreachScheduler] premier passage échoué:", e));
  setInterval(() => {
    runScan().catch((e) => console.error("[outreachScheduler] passage échoué:", e));
  }, CHECK_INTERVAL_MS);
  console.log("[outreachScheduler] démarré (premier passage immédiat, puis toutes les 6h)");
}

export { runScan as runOutreachScanNow };
