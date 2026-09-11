import { HttpError } from "./asyncHandler";

const META_GRAPH_API_BASE = "https://graph.facebook.com/v21.0";

interface MetaCfg {
  apiKey: string | null;
  /** WABA ID (ID du compte WhatsApp Business) — réutilise ChannelConfig.baseUrl, inutilisé par ailleurs pour le provider "meta". */
  baseUrl: string | null;
}

export const META_TEMPLATE_CATEGORIES = ["UTILITY", "MARKETING", "AUTHENTICATION"] as const;
export type MetaTemplateCategory = (typeof META_TEMPLATE_CATEGORIES)[number];

function wabaId(cfg: MetaCfg): string {
  if (!cfg.baseUrl || !cfg.baseUrl.trim()) {
    throw new HttpError(400, "ID du compte WhatsApp Business (WABA) manquant — complétez-le dans la configuration du canal WhatsApp avant de créer un modèle");
  }
  return cfg.baseUrl.trim();
}

async function metaGraphRequest(cfg: MetaCfg, path: string, init: { method: "GET" | "POST"; body?: unknown }) {
  if (!cfg.apiKey) throw new HttpError(400, "Jeton d'accès Meta manquant");
  let res: Response;
  try {
    res = await fetch(`${META_GRAPH_API_BASE}${path}`, {
      method: init.method,
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (err) {
    throw new HttpError(502, "Échec de connexion à l'API Meta : " + String(err instanceof Error ? err.message : err));
  }
  const text = await res.text();
  let j: { error?: { message?: string; error_user_msg?: string; code?: number; error_subcode?: number }; [k: string]: unknown } = {};
  try {
    j = JSON.parse(text);
  } catch {
    // corps non-JSON, géré ci-dessous via `text` brut
  }
  if (!res.ok) {
    const e = j.error;
    const detail = e?.error_user_msg || e?.message || text || `HTTP ${res.status}`;
    const code = e?.code !== undefined ? ` [code Meta ${e.code}${e.error_subcode ? "." + e.error_subcode : ""}]` : "";
    throw new HttpError(502, `Échec de la requête Meta (HTTP ${res.status}) : ${detail}${code}`);
  }
  return j;
}

/**
 * Meta n'accepte que des noms de modèle en minuscules, chiffres et
 * underscores — contrairement à Sesame Suite dont la clé de modèle (key)
 * est plus permissive (utilisée aussi pour email/sms). Normalisation plutôt
 * que rejet, pour éviter d'imposer une contrainte Meta-spécifique au champ
 * générique "key" du modèle.
 */
export function normalizeMetaTemplateName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 512);
}

/**
 * Convertit les variables nommées {{prenom}}, {{code}}... en emplacements
 * positionnels {{1}}, {{2}}... exigés par Meta — même logique et même ordre
 * que extractOrderedVariableValues() dans lib/messaging.ts (une occurrence =
 * un emplacement, y compris les répétitions d'une même variable), pour que
 * le template approuvé chez Meta corresponde exactement à ce que l'envoi
 * réel enverra ensuite.
 */
export function toMetaTemplateBody(bodyHtml: string): string {
  let i = 0;
  return bodyHtml.replace(/\{\{\s*\w+\s*\}\}/g, () => `{{${++i}}}`);
}

/**
 * Meta renvoie ce code générique sur un rejet automatique (analyse de
 * contenu synchrone, avant toute revue humaine) — la valeur brute (ex.
 * "INCORRECT_CATEGORY", "TAG_CONTENT_MISMATCH", "SCAM"...) n'est ni traduite
 * ni toujours limpide pour un non-initié, d'où ce lexique best-effort.
 * Liste non exhaustive : Meta peut renvoyer d'autres valeurs, affichées
 * telles quelles si absentes d'ici plutôt que masquées.
 */
const REJECTED_REASON_FR: Record<string, string> = {
  INCORRECT_CATEGORY:
    "Catégorie incorrecte — le contenu ne correspond pas à la catégorie choisie (ex. un ton d'accueil/promotionnel soumis en \"Utilitaire\" doit souvent passer en \"Marketing\").",
  TAG_CONTENT_MISMATCH: "Le contenu ne correspond pas à la catégorie déclarée.",
  INVALID_FORMAT: "Format invalide (variables mal placées, composants incohérents).",
  ABUSIVE_CONTENT: "Contenu jugé abusif ou trompeur.",
  SCAM: "Contenu jugé relever d'une tentative d'hameçonnage/arnaque — souvent déclenché par une demande d'identifiants (email + code) couplée à un lien externe.",
  PROMOTIONAL: "Contenu jugé promotionnel — à soumettre en catégorie \"Marketing\" plutôt qu'\"Utilitaire\".",
  NONE: "Aucun motif détaillé fourni par Meta.",
};

function explainRejectedReason(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return REJECTED_REASON_FR[raw] ? `${raw} — ${REJECTED_REASON_FR[raw]}` : raw;
}

export async function createMetaMessageTemplate(
  cfg: MetaCfg,
  opts: { name: string; category: string; bodyHtml: string }
) {
  const name = normalizeMetaTemplateName(opts.name);
  if (!name) throw new HttpError(400, "Nom de modèle invalide (lettres, chiffres et underscores uniquement)");
  const category = META_TEMPLATE_CATEGORIES.includes(opts.category as MetaTemplateCategory) ? opts.category : "UTILITY";
  const bodyText = toMetaTemplateBody(opts.bodyHtml);
  if (!bodyText.trim()) throw new HttpError(400, "Corps du message requis");
  const j = await metaGraphRequest(cfg, `/${wabaId(cfg)}/message_templates`, {
    method: "POST",
    body: {
      name,
      language: "fr",
      category,
      components: [{ type: "BODY", text: bodyText }],
    },
  });
  const status = (j.status as string) || "PENDING";
  let rejectedReason: string | undefined;
  // La réponse de création ne porte jamais le motif de rejet (même pour un
  // rejet synchrone immédiat) — il faut une requête de lecture séparée pour
  // l'obtenir, cf. listMetaMessageTemplates.
  if (status === "REJECTED") {
    try {
      const rows = await listMetaMessageTemplates(cfg);
      const match = rows.find((r) => r.name === name);
      rejectedReason = explainRejectedReason(match?.rejectedReason);
    } catch (e) {
      console.error("[metaTemplates] échec de la lecture du motif de rejet :", e);
    }
  }
  return {
    name,
    id: (j.id as string) || "",
    status,
    category: (j.category as string) || category,
    rejectedReason,
  };
}

export async function listMetaMessageTemplates(cfg: MetaCfg) {
  const j = await metaGraphRequest(
    cfg,
    `/${wabaId(cfg)}/message_templates?fields=name,status,category,language,rejected_reason&limit=200`,
    { method: "GET" }
  );
  const rows = (j.data || []) as { name: string; status: string; category: string; language: string; rejected_reason?: string }[];
  // Meta renvoie rejected_reason en snake_case (comme tous ses champs) —
  // reformaté ici en camelCase pour rester cohérent avec le reste du code TS.
  return rows.map((r) => ({ name: r.name, status: r.status, category: r.category, language: r.language, rejectedReason: r.rejected_reason }));
}
