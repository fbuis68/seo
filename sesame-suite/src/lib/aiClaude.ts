import { config } from "../config";
import { HttpError } from "./asyncHandler";

/**
 * Génération de texte de l'assistant support (§ LOT 1, étapes 2 et 3) —
 * Claude uniquement (cf. lib/aiEmbeddings.ts pour la vectorisation OpenAI,
 * fournisseur distinct). Appel brut à l'API Messages (fetch, sans SDK),
 * même convention que lib/graph.ts pour Microsoft Graph.
 *
 * Point de vigilance central du cahier des charges (§ "connaissance
 * générique vs données propres au client") : le prompt système interdit
 * explicitement de reprendre des données nominatives/contractuelles d'un
 * autre ticket — seule la CONNAISSANCE DE RÉSOLUTION (comment le problème a
 * été réglé) doit être réutilisée, jamais les coordonnées, contrats ou
 * détails commerciaux d'un client tiers.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export function aiClaudeConfigured(): boolean {
  return !!config.anthropicApiKey;
}

async function callClaude(params: { system: string; messages: { role: "user" | "assistant"; content: string }[]; tool: AnthropicTool; maxTokens?: number }): Promise<Record<string, unknown>> {
  if (!config.anthropicApiKey) throw new HttpError(503, "Assistant IA non configuré (ANTHROPIC_API_KEY manquant)");
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: params.maxTokens || 1500,
      system: params.system,
      messages: params.messages,
      tools: [params.tool],
      tool_choice: { type: "tool", name: params.tool.name },
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new HttpError(502, `Échec de l'appel Claude (${r.status}) : ${body.slice(0, 300)}`);
  }
  const data = (await r.json()) as { content?: { type: string; input?: Record<string, unknown> }[] };
  const toolUse = (data.content || []).find((c) => c.type === "tool_use");
  if (!toolUse?.input) throw new HttpError(502, "Réponse Claude inattendue (pas d'appel d'outil)");
  return toolUse.input;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const SAFETY_RULES = `Règle absolue : tu peux réutiliser la CONNAISSANCE GÉNÉRIQUE de résolution des cas fournis (la manière dont un problème similaire a été réglé), mais tu ne dois JAMAIS reprendre de données propres à un autre client dans ces cas (nom, société, email, numéro de contrat, montants, identifiants de réservation, tout détail nominatif ou commercial). Si un cas source contient de telles données, généralise-les (ex : "le modèle associé à la session" plutôt qu'un identifiant précis relevé dans un autre ticket).`;

export interface ReplySourceInput {
  id: string; // "ticket:<id>" ou "faq:<id>"
  type: "ticket" | "faq";
  label: string;
  text: string; // résumé de résolution / réponse FAQ
}

export interface SuggestedReply {
  text: string;
  confidence: number; // 0-1
  sourcesUsed: { id: string; type: "ticket" | "faq"; label: string }[];
}

const REPLY_TOOL: AnthropicTool = {
  name: "submit_reply",
  description: "Soumet la réponse support proposée.",
  input_schema: {
    type: "object",
    properties: {
      reply_text: { type: "string", description: "Réponse au client, en français, prête à être envoyée telle quelle ou éditée par l'opérateur." },
      confidence: { type: "integer", minimum: 0, maximum: 100, description: "Confiance dans la pertinence de cette réponse (0-100), en fonction de la proximité réelle des cas similaires fournis." },
      sources_used: { type: "array", items: { type: "string" }, description: "Liste des identifiants de sources (parmi ceux fournis) réellement utilisés pour construire la réponse." },
    },
    required: ["reply_text", "confidence", "sources_used"],
  },
};

/**
 * Construit une proposition de réponse à partir du nouveau ticket, des
 * tickets similaires déjà résolus et des FAQ pertinentes. N'envoie jamais
 * rien : le texte retourné reste une proposition, la validation humaine est
 * obligatoire côté route (cf. routes/crmTicket.ts, jamais d'appel
 * d'envoi automatique depuis ce module).
 */
export async function generateSuggestedReply(params: { subject: string; question: string; sources: ReplySourceInput[] }): Promise<SuggestedReply> {
  const sourcesBlock = params.sources.length
    ? params.sources.map((s) => `[${s.id}] (${s.type === "ticket" ? "ticket similaire" : "FAQ"} — ${s.label})\n${s.text}`).join("\n\n---\n\n")
    : "(aucun cas similaire ni FAQ disponible — réponds au mieux à partir du seul ticket, avec une confiance faible)";

  const system = `Tu es l'assistant d'une équipe de support technique du logiciel Sesame Suite (gestion hôtelière). Tu rédiges une proposition de réponse à un ticket client, en français, professionnelle et directement actionnable. ${SAFETY_RULES}`;
  const userMsg = `Nouveau ticket :\nSujet : ${params.subject}\nMessage du client : ${params.question}\n\nCas similaires et FAQ disponibles (identifiants entre crochets) :\n\n${sourcesBlock}`;

  const input = await callClaude({ system, messages: [{ role: "user", content: userMsg }], tool: REPLY_TOOL });
  const usedIds = new Set(Array.isArray(input.sources_used) ? (input.sources_used as string[]) : []);
  const sourcesUsed = params.sources.filter((s) => usedIds.has(s.id)).map((s) => ({ id: s.id, type: s.type, label: s.label }));
  const confidence = typeof input.confidence === "number" ? Math.max(0, Math.min(100, input.confidence)) / 100 : 0.5;

  return { text: String(input.reply_text || "").trim(), confidence, sourcesUsed };
}

const TRANSFORM_TOOL: AnthropicTool = {
  name: "submit_reply",
  description: "Soumet le texte reformulé.",
  input_schema: {
    type: "object",
    properties: { reply_text: { type: "string" } },
    required: ["reply_text"],
  },
};

const TRANSFORM_INSTRUCTIONS: Record<"shorten" | "pedagogical" | "technical", string> = {
  shorten: "Raccourcis ce texte au maximum tout en gardant l'information essentielle et l'action à faire — vise 2 à 3 phrases.",
  pedagogical: "Réécris ce texte pour un utilisateur peu à l'aise avec l'informatique : plus explicatif, étapes numérotées si pertinent, vocabulaire simple, ton rassurant.",
  technical: "Réécris ce texte pour un interlocuteur technique (administrateur IT côté client) : plus précis, direct, sans réexpliquer les évidences.",
};

/** Reformule un texte de réponse déjà proposé (raccourcir / plus pédagogique
 * / plus technique) — ne rappelle PAS les sources, seule la formulation
 * change, les sources/confiance de la suggestion d'origine restent valables. */
export async function transformSuggestionText(text: string, mode: "shorten" | "pedagogical" | "technical"): Promise<string> {
  const system = `Tu reformules un texte de réponse support déjà rédigé, en français, sans changer son sens ni inventer d'information nouvelle. ${SAFETY_RULES}`;
  const userMsg = `${TRANSFORM_INSTRUCTIONS[mode]}\n\nTexte à reformuler :\n${text}`;
  const input = await callClaude({ system, messages: [{ role: "user", content: userMsg }], tool: TRANSFORM_TOOL, maxTokens: 800 });
  return String(input.reply_text || "").trim();
}

const FAQ_TOOL: AnthropicTool = {
  name: "submit_faq",
  description: "Soumet la proposition de FAQ structurée.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Titre court de la FAQ." },
      question: { type: "string", description: "Question principale, telle qu'un client la formulerait." },
      variants: { type: "array", items: { type: "string" }, description: "3 à 5 reformulations possibles de la même question." },
      short_answer: { type: "string", description: "Réponse courte, 1-2 phrases." },
      detailed_answer: { type: "string", description: "Réponse détaillée." },
      procedure_steps: { type: "array", items: { type: "string" }, description: "Étapes numérotées de la procédure de résolution, si applicable (sinon liste vide)." },
      module: { type: "string", description: "Module Sesame concerné si identifiable, sinon chaîne vide." },
      category: { type: "string", description: "Catégorie (Incident technique | Bug | Question | Demande | Facturation | Autre)." },
      keywords: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["title", "question", "variants", "short_answer", "detailed_answer", "procedure_steps", "module", "category", "keywords", "tags"],
  },
};

export interface FaqDraft {
  title: string;
  question: string;
  variants: string[];
  shortAnswer: string;
  detailedAnswer: string;
  procedure: string[];
  module: string;
  category: string;
  keywords: string[];
  tags: string[];
}

/**
 * Génère une proposition de FAQ à partir d'un ticket résolu (§ étape 3,
 * "capitalisation"). Ne publie jamais rien : la route appelante enregistre
 * systématiquement en status="draft" (cf. routes/crmTicket.ts), la
 * publication reste une action humaine explicite.
 */
export async function generateFaqDraft(params: { subject: string; threadText: string }): Promise<FaqDraft> {
  const system = `Tu extrais une FAQ générique et réutilisable à partir d'un ticket support déjà résolu. ${SAFETY_RULES} La FAQ doit être utile pour un futur client rencontrant le MÊME TYPE de problème — jamais spécifique à ce ticket précis (aucun nom de client, société, email, numéro de contrat, réservation ou tout identifiant propre à ce cas).`;
  const userMsg = `Sujet du ticket : ${params.subject}\n\nFil de discussion complet :\n${params.threadText}`;
  const input = await callClaude({ system, messages: [{ role: "user", content: userMsg }], tool: FAQ_TOOL, maxTokens: 2000 });
  return {
    title: String(input.title || "").trim(),
    question: String(input.question || "").trim(),
    variants: Array.isArray(input.variants) ? (input.variants as string[]).filter(Boolean) : [],
    shortAnswer: String(input.short_answer || "").trim(),
    detailedAnswer: String(input.detailed_answer || "").trim(),
    procedure: Array.isArray(input.procedure_steps) ? (input.procedure_steps as string[]).filter(Boolean) : [],
    module: String(input.module || "").trim(),
    category: String(input.category || "").trim(),
    keywords: Array.isArray(input.keywords) ? (input.keywords as string[]).filter(Boolean) : [],
    tags: Array.isArray(input.tags) ? (input.tags as string[]).filter(Boolean) : [],
  };
}
