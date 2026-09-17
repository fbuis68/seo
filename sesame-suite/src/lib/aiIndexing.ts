import { prisma } from "../db";
import { aiEmbeddingsConfigured, buildTicketEmbeddingText, generateEmbedding } from "./aiEmbeddings";

/**
 * Indexation sémantique d'un ticket résolu (§ LOT 1, étape 1 "cas
 * similaires") — appelée à la clôture d'un ticket (cf. routes/crmTicket.ts)
 * et par le script de rattrapage pour les tickets déjà fermés avant la mise
 * en place de l'assistant IA (cf. scripts/backfillTicketEmbeddings.ts).
 *
 * Ne lève jamais : un échec (clé API absente, appel OpenAI en erreur) ne
 * doit jamais bloquer la fermeture d'un ticket — juste ne pas l'indexer,
 * il restera exclu des "cas similaires" jusqu'à un prochain passage.
 * Retourne true si le ticket a bien été indexé (utilisé par le script de
 * rattrapage pour distinguer un vrai succès d'un ticket ignoré/en échec).
 */
export async function reindexTicketEmbedding(ticketId: string): Promise<boolean> {
  if (!aiEmbeddingsConfigured()) return false;
  try {
    const ticket = await prisma.crmTicket.findUnique({
      where: { id: ticketId },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!ticket) return false;

    const firstClientMessage = ticket.messages.find((m) => m.authorType === "client" && m.kind !== "system")?.body || "";

    let resolutionSummary = ticket.resolutionSummary || "";
    if (!resolutionSummary) {
      const lastAgentReply = [...ticket.messages].reverse().find((m) => m.authorType === "agent" && m.kind === "reply");
      resolutionSummary = (lastAgentReply?.body || "").trim().slice(0, 2000);
    }
    if (!resolutionSummary) return false; // rien à vectoriser (ticket sans réponse agent) — pas d'erreur, juste rien à faire

    const text = buildTicketEmbeddingText({ subject: ticket.subject, firstClientMessage, resolutionSummary });
    const embedding = await generateEmbedding(text);

    await prisma.crmTicket.update({
      where: { id: ticketId },
      data: {
        embedding,
        embeddingUpdatedAt: new Date(),
        ...(ticket.resolutionSummary ? {} : { resolutionSummary }),
      },
    });
    return true;
  } catch (e) {
    console.error(`[aiIndexing] échec de l'indexation du ticket ${ticketId}:`, e);
    return false;
  }
}

/** Même principe pour une FAQ publiée (§ étape 3) — indexée seulement au
 * moment de la publication (jamais un brouillon), question + variantes +
 * réponse courte servant de base à l'embedding. */
export async function reindexFaqEmbedding(faqId: string): Promise<void> {
  if (!aiEmbeddingsConfigured()) return;
  try {
    const faq = await prisma.faq.findUnique({ where: { id: faqId } });
    if (!faq) return;
    const text = [faq.title, faq.question, ...faq.variants, faq.shortAnswer].filter(Boolean).join("\n\n");
    if (!text.trim()) return;
    const embedding = await generateEmbedding(text);
    await prisma.faq.update({ where: { id: faqId }, data: { embedding, embeddingUpdatedAt: new Date() } });
  } catch (e) {
    console.error(`[aiIndexing] échec de l'indexation de la FAQ ${faqId}:`, e);
  }
}
