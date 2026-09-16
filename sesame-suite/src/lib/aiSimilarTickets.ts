import { prisma } from "../db";
import { CrmTicket, CrmTicketMessage } from "@prisma/client";
import { cosineSimilarity, generateEmbedding } from "./aiEmbeddings";
import { ONBOARDING_MODULES } from "../routes/onboarding";

/**
 * Recherche de "cas similaires" (§ LOT 1, étape 1) — le vecteur du ticket
 * interrogé (souvent encore ouvert, donc sans résolution à vectoriser) est
 * toujours recalculé à la volée à partir du sujet + 1er message client :
 * pas de cache sur CrmTicket.embedding pour ce cas, ce champ portant déjà
 * un sens précis (résolution d'un ticket clos, cf. lib/aiIndexing.ts) —
 * les deux usages ne doivent pas se mélanger. Coût négligeable
 * (text-embedding-3-small), un panneau de ticket n'est pas ouvert des
 * milliers de fois par minute.
 */

const MODULE_LABELS = new Map<string, string>(ONBOARDING_MODULES.map((m) => [m.k, m.label]));

export interface SimilarTicketResult {
  similarity: number; // 0-1
  ticketId: string;
  number: string;
  subject: string;
  question: string;
  resolutionSummary: string;
  closedAt: Date | null;
  produit: string;
  module: string;
  category: string;
  agentName: string;
}

export function firstClientMessage(messages: CrmTicketMessage[]): string {
  return messages.find((m) => m.authorType === "client" && m.kind !== "system")?.body || "";
}

/** Embedding de requête d'un ticket interrogé — voir note en tête de
 * fichier : jamais mis en cache sur CrmTicket.embedding. Retourne null sans
 * appeler l'API si le ticket n'a ni sujet ni message client (rien à
 * chercher). Partagé entre la recherche de cas similaires (étape 1) et la
 * génération de réponse suggérée (étape 2), pour un seul appel d'embedding
 * par chargement de panneau plutôt que deux. */
export async function computeTicketQueryEmbedding(ticket: CrmTicket & { messages: CrmTicketMessage[] }): Promise<number[] | null> {
  const queryText = [ticket.subject, firstClientMessage(ticket.messages)].filter(Boolean).join("\n\n");
  if (!queryText.trim()) return null;
  return generateEmbedding(queryText);
}

export async function findSimilarTickets(queryEmbedding: number[], excludeTicketId: string, limit = 5): Promise<SimilarTicketResult[]> {
  const candidates = await prisma.crmTicket.findMany({
    where: {
      id: { not: excludeTicketId },
      embeddingUpdatedAt: { not: null },
    },
    include: { agent: { select: { name: true, email: true } }, messages: { orderBy: { createdAt: "asc" } } },
  });

  const ranked = candidates
    .map((c) => ({ ticket: c, similarity: cosineSimilarity(queryEmbedding, c.embedding) }))
    .filter((r) => r.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return ranked.map(({ ticket: c, similarity }) => ({
    similarity,
    ticketId: c.id,
    number: c.number,
    subject: c.subject,
    question: firstClientMessage(c.messages),
    resolutionSummary: c.resolutionSummary || "",
    closedAt: c.closedAt,
    produit: "Sesame Suite",
    module: c.module ? MODULE_LABELS.get(c.module) || c.module : "",
    category: c.type || "",
    agentName: c.agent ? c.agent.name || c.agent.email : "",
  }));
}

export interface RelevantFaqResult {
  similarity: number;
  faqId: string;
  title: string;
  shortAnswer: string;
}

/** Même principe sur les FAQ publiées (§ étape 2, "sources utilisées" —
 * FAQ #32 dans l'exemple du cahier des charges) — jamais sur un brouillon,
 * qui n'a pas encore été validé par un humain. */
export async function findRelevantFaqs(queryEmbedding: number[], limit = 3): Promise<RelevantFaqResult[]> {
  const candidates = await prisma.faq.findMany({ where: { status: "published", embeddingUpdatedAt: { not: null } } });
  return candidates
    .map((f) => ({ similarity: cosineSimilarity(queryEmbedding, f.embedding), faqId: f.id, title: f.title, shortAnswer: f.shortAnswer }))
    .filter((r) => r.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}
