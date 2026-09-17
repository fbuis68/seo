/**
 * Rattrapage ponctuel : indexe (embedding + resolutionSummary déduit) tous
 * les tickets Résolu/Fermé déjà en base qui n'ont pas encore de vecteur —
 * nécessaire une seule fois après la mise en place de l'assistant IA (§ LOT
 * 1), les tickets clôturés après coup sont eux indexés automatiquement (cf.
 * routes/crmTicket.ts). Nécessite OPENAI_API_KEY configuré.
 *
 * Appelle l'API OpenAI en série (pas de Promise.all), avec une pause entre
 * chaque appel (cf. PACE_MS) — un compte qui vient d'être crédité démarre
 * souvent sur un palier de débit bas (observé : 100 requêtes/min, 40 000
 * tokens/min), largement en dessous du volume d'un import en masse sans
 * cette pause. generateEmbedding() reste par ailleurs résilient (nouvelle
 * tentative automatique sur 429, cf. lib/aiEmbeddings.ts) en filet de
 * sécurité si la pause ne suffit pas exactement.
 */
import { PrismaClient } from "@prisma/client";
import { reindexTicketEmbedding } from "../src/lib/aiIndexing";
import { aiEmbeddingsConfigured } from "../src/lib/aiEmbeddings";

const prisma = new PrismaClient();

// 700ms ≈ 85 req/min, sous la limite de 100/min observée sur un compte
// tout juste crédité (cf. commentaire ci-dessus) — marge volontaire.
const PACE_MS = 700;
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!aiEmbeddingsConfigured()) {
    console.error("OPENAI_API_KEY non configuré — rien à faire.");
    process.exit(1);
  }

  const rows = await prisma.crmTicket.findMany({
    where: { status: { in: ["Résolu", "Fermé"] }, embeddingUpdatedAt: null },
    select: { id: true, number: true },
  });
  console.log(`${rows.length} ticket(s) à indexer.`);

  let done = 0;
  let ok = 0;
  const failed: string[] = [];
  for (const t of rows) {
    if (await reindexTicketEmbedding(t.id)) ok++;
    else failed.push(t.id);
    done++;
    if (done % 20 === 0) console.log(`  ${done}/${rows.length}…`);
    if (done < rows.length) await sleep(PACE_MS);
  }
  console.log(`Terminé : ${ok}/${rows.length} ticket(s) indexé(s).`);
  if (failed.length) {
    console.log(`${failed.length} non indexé(s) — soit erreur API transitoire (relancer ce script les reprendra), soit ticket sans réponse agent exploitable (restera non indexé, normal) :`);
    console.log(failed.slice(0, 10).join(", ") + (failed.length > 10 ? "…" : ""));
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
