/**
 * Rattrapage ponctuel : indexe (embedding + resolutionSummary déduit) tous
 * les tickets Résolu/Fermé déjà en base qui n'ont pas encore de vecteur —
 * nécessaire une seule fois après la mise en place de l'assistant IA (§ LOT
 * 1), les tickets clôturés après coup sont eux indexés automatiquement (cf.
 * routes/crmTicket.ts). Nécessite OPENAI_API_KEY configuré.
 *
 * Appelle l'API OpenAI en série (pas de Promise.all) pour rester sous les
 * limites de débit par défaut d'un compte — volumétrie d'un support
 * mono-produit, pas besoin de parallélisme ici.
 */
import { PrismaClient } from "@prisma/client";
import { reindexTicketEmbedding } from "../src/lib/aiIndexing";
import { aiEmbeddingsConfigured } from "../src/lib/aiEmbeddings";

const prisma = new PrismaClient();

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
  for (const t of rows) {
    await reindexTicketEmbedding(t.id);
    done++;
    if (done % 20 === 0) console.log(`  ${done}/${rows.length}…`);
  }
  console.log(`Terminé : ${done} ticket(s) traité(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
