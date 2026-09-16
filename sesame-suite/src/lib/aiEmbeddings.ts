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

export async function generateEmbedding(text: string): Promise<number[]> {
  if (!config.openaiApiKey) throw new HttpError(503, "Assistant IA non configuré (OPENAI_API_KEY manquant)");
  const input = text.trim().slice(0, 8000); // marge large sous la limite de tokens du modèle
  if (!input) throw new HttpError(400, "Texte vide, impossible de générer un embedding");

  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: config.openaiEmbeddingModel, input }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new HttpError(502, `Échec de la génération d'embedding (OpenAI ${r.status}) : ${body.slice(0, 300)}`);
  }
  const data = (await r.json()) as { data?: { embedding?: number[] }[] };
  const embedding = data.data?.[0]?.embedding;
  if (!embedding || !embedding.length) throw new HttpError(502, "Réponse OpenAI inattendue (pas d'embedding)");
  return embedding;
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
