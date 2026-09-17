import { config } from "../config";
import { HttpError } from "./asyncHandler";

/**
 * Recherche sémantique de l'assistant support (§ LOT 1) — embeddings
 * OpenAI text-embedding-3-small. Claude n'a pas d'API d'embeddings native,
 * d'où ce second fournisseur utilisé UNIQUEMENT pour vectoriser (jamais
 * pour générer du texte, cf. lib/aiClaude.ts).
 *
 * Pas de pgvector ni de base vectorielle externe : les vecteurs sont
 * stockés en colonnes Float[] Postgres (CrmTicket.embedding, Faq.embedding)
 * et comparés par cosinus en mémoire côté Node — volumétrie d'un support
 * mono-produit largement compatible avec cette approche (cf. cahier des
 * charges LOT 1, "ne pas surdimensionner l'architecture"). À reconsidérer
 * seulement si le nombre de tickets/FAQ indexés devient réellement massif.
 */

export function aiEmbeddingsConfigured(): boolean {
  return !!config.openaiApiKey;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extrait le délai suggéré par OpenAI dans le corps de l'erreur 429
 * ("Please try again in 217ms" / "in 1.2s") — bien plus précis qu'un
 * backoff fixe pour repartir dès que la fenêtre de débit se libère,
 * important sur un compte à faible limite (ex. 100 req/min, 40k tokens/min
 * en sortie de crédit tout juste ajouté). */
function parseRetryAfterMs(body: string): number | null {
  const m = /try again in ([\d.]+)(ms|s)/i.exec(body);
  if (!m) return null;
  const value = parseFloat(m[1]);
  return m[2] === "s" ? value * 1000 : value;
}

const MAX_RETRIES = 6;

/**
 * Nouvelle tentative automatique sur 429 (limite de débit OpenAI) — jamais
 * sur une autre erreur (401/402/insufficient_quota... : retenter n'y change
 * rien). Un compte qui vient d'être crédité démarre souvent sur un palier
 * de débit bas (ex. 100 req/min) : un import en masse (§ scripts/
 * backfill-ticket-embeddings.ts, scripts/import-freshdesk-tickets.ts) le
 * dépasse presque à coup sûr sans ce mécanisme.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  if (!config.openaiApiKey) throw new HttpError(503, "Assistant IA non configuré (OPENAI_API_KEY manquant)");
  const input = text.trim().slice(0, 8000); // marge large sous la limite de tokens du modèle
  if (!input) throw new HttpError(400, "Texte vide, impossible de générer un embedding");

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: config.openaiEmbeddingModel, input }),
    });
    if (r.ok) {
      const data = (await r.json()) as { data?: { embedding?: number[] }[] };
      const embedding = data.data?.[0]?.embedding;
      if (!embedding || !embedding.length) throw new HttpError(502, "Réponse OpenAI inattendue (pas d'embedding)");
      return embedding;
    }

    const body = await r.text().catch(() => "");
    if (r.status === 429 && attempt < MAX_RETRIES) {
      const delay = parseRetryAfterMs(body) ?? 1000 * 2 ** attempt; // repli exponentiel si le message n'indique pas de délai
      await sleep(Math.min(delay, 15000) + 50); // petite marge au-delà du délai annoncé
      continue;
    }
    throw new HttpError(502, `Échec de la génération d'embedding (OpenAI ${r.status}) : ${body.slice(0, 300)}`);
  }
  throw new HttpError(502, "Échec de la génération d'embedding (limite de débit OpenAI persistante)");
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Texte concaténé qui sert de base à l'embedding d'un ticket — sujet +
 * question initiale du client + résumé de résolution. Volontairement PAS
 * l'intégralité du fil (bruyant, et risquerait de vectoriser des données
 * propres au client plutôt que la connaissance générique de résolution). */
export function buildTicketEmbeddingText(params: { subject: string; firstClientMessage: string; resolutionSummary: string }): string {
  return [params.subject, params.firstClientMessage, params.resolutionSummary].filter(Boolean).join("\n\n");
}
