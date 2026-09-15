import { config } from "../config";
import { HttpError } from "./asyncHandler";

/**
 * Client Microsoft Graph minimal (client credentials, "app-only") — lecture
 * de la boîte support et gestion de l'abonnement webhook (changeType=created
 * sur les messages) qui remplace la règle Outlook + flux Power Automate
 * historique. Pas de SDK (@azure/msal-node, @microsoft/microsoft-graph-client)
 * pour rester cohérent avec le reste du projet, qui appelle les API
 * externes en fetch() brut (cf. lib/sms.ts pour Twilio, routes/geocode.ts) —
 * la surface utilisée ici (token, GET message, CRUD subscription) est trop
 * réduite pour justifier une dépendance de plus.
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export function graphConfigured(): boolean {
  return !!(config.graphTenantId && config.graphClientId && config.graphClientSecret);
}

// ── Jeton d'accès — mis en cache en mémoire process, renouvelé un peu avant
// son expiration réelle (marge de 2 min) pour éviter un aller-retour OAuth
// à chaque appel Graph. Perdu à chaque redémarrage du serveur, sans
// conséquence (un simple re-fetch au prochain appel).
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getGraphToken(): Promise<string> {
  if (!graphConfigured()) throw new HttpError(500, "Microsoft Graph non configuré (GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET)");
  if (cachedToken && cachedToken.expiresAt > Date.now() + 2 * 60_000) return cachedToken.value;

  const r = await fetch(`https://login.microsoftonline.com/${config.graphTenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.graphClientId,
      client_secret: config.graphClientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const data = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!r.ok || !data.access_token) {
    throw new HttpError(502, `Authentification Microsoft Graph échouée : ${data.error_description || r.status}`);
  }
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function graphFetch(path: string, init?: RequestInit): Promise<unknown> {
  const token = await getGraphToken();
  const r = await fetch(`${GRAPH_BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new HttpError(502, `Microsoft Graph ${r.status} sur ${path} : ${body.slice(0, 300)}`);
  }
  if (r.status === 204) return null;
  return r.json();
}

export interface GraphAttachment {
  name: string;
  contentType: string;
  contentBytes: string; // base64, tel que renvoyé par Graph
}

export interface GraphMessage {
  id: string;
  subject: string;
  from: string; // adresse email de l'expéditeur
  fromName: string;
  bodyText: string;
  attachments: GraphAttachment[];
}

// Entités HTML nommées courantes dans un email (accents français inclus) —
// pas de table exhaustive, juste de quoi éviter des "&eacute;"/"&agrave;"
// littéraux dans le corps affiché (cf. stripHtml ci-dessous).
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  eacute: "é", Eacute: "É", egrave: "è", Egrave: "È", ecirc: "ê", euml: "ë",
  agrave: "à", Agrave: "À", acirc: "â", auml: "ä",
  ocirc: "ô", ouml: "ö", ucirc: "û", ugrave: "ù", uuml: "ü",
  ccedil: "ç", Ccedil: "Ç", iuml: "ï", icirc: "î",
  oelig: "œ", OElig: "Œ", mdash: "—", ndash: "–", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : m));
}

/**
 * Convertit un corps HTML en texte lisible en conservant les retours à la
 * ligne — l'ancienne version remplaçait CHAQUE balise (y compris <br>,
 * </p>, </div>...) par un simple espace puis écrasait tout \s+ en un seul
 * espace, ce qui aplatissait un email entier (paragraphes + citation
 * "De/Objet/Envoyé" Outlook incluse) en un unique mur de texte illisible
 * dans le fil de discussion d'un ticket (cf. 15/09/2026). Les balises de
 * bloc/saut de ligne deviennent maintenant \n avant la suppression du
 * reste des balises, et seul l'espace horizontal (pas les \n) est
 * collapsé ensuite.
 */
function stripHtml(html: string): string {
  const withoutTags = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(withoutTags)
    .replace(/[^\S\n]+/g, " ") // espace horizontal uniquement — jamais les \n
    .replace(/[ \t]*\n[ \t]*/g, "\n") // pas d'espaces traînants en début/fin de ligne
    .replace(/\n{3,}/g, "\n\n") // jamais plus d'une ligne vide consécutive
    .trim();
}

/**
 * Récupère un message par id — les notifications Graph ne contiennent
 * jamais le contenu (sujet/corps/expéditeur), seulement une référence
 * (resourceData.id) : cet appel est donc systématique après chaque
 * notification, cf. routes/graphMail.ts.
 */
export async function getGraphMessage(mailbox: string, messageId: string): Promise<GraphMessage> {
  const msg = (await graphFetch(
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}?$select=subject,from,body,hasAttachments`
  )) as {
    subject?: string;
    from?: { emailAddress?: { address?: string; name?: string } };
    body?: { contentType?: string; content?: string };
    hasAttachments?: boolean;
  };

  let attachments: GraphAttachment[] = [];
  if (msg.hasAttachments) {
    const att = (await graphFetch(
      `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments?$select=name,contentType,contentBytes,isInline`
    )) as { value?: (GraphAttachment & { isInline?: boolean })[] };
    // Les images intégrées à la signature (logo, etc.) ne sont pas des
    // pièces jointes utiles à un ticket support.
    attachments = (att.value || []).filter((a) => !a.isInline).map((a) => ({ name: a.name, contentType: a.contentType, contentBytes: a.contentBytes }));
  }

  const rawBody = msg.body?.content || "";
  const bodyText = msg.body?.contentType === "html" ? stripHtml(rawBody) : rawBody;

  return {
    id: messageId,
    subject: msg.subject || "(sans objet)",
    from: msg.from?.emailAddress?.address || "",
    fromName: msg.from?.emailAddress?.name || "",
    bodyText,
    attachments,
  };
}

export interface GraphSubscriptionResult {
  id: string;
  expirationDateTime: string;
}

/**
 * Durée max autorisée par Graph pour un abonnement sur la ressource
 * "message" : 4230 minutes (~2,9 jours) — on vise un peu en dessous par
 * prudence, et un renouvellement périodique (cf. lib/graphSubscriptionScheduler.ts)
 * le prolonge bien avant l'échéance.
 */
const SUBSCRIPTION_MINUTES = 4200;

export async function createGraphSubscription(mailbox: string, notificationUrl: string, clientState: string): Promise<GraphSubscriptionResult> {
  const expirationDateTime = new Date(Date.now() + SUBSCRIPTION_MINUTES * 60_000).toISOString();
  const result = (await graphFetch("/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      changeType: "created",
      notificationUrl,
      resource: `/users/${mailbox}/mailFolders('Inbox')/messages`,
      expirationDateTime,
      clientState,
    }),
  })) as GraphSubscriptionResult;
  return result;
}

export async function renewGraphSubscription(subscriptionId: string): Promise<GraphSubscriptionResult> {
  const expirationDateTime = new Date(Date.now() + SUBSCRIPTION_MINUTES * 60_000).toISOString();
  const result = (await graphFetch(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ expirationDateTime }),
  })) as GraphSubscriptionResult;
  return result;
}

export async function deleteGraphSubscription(subscriptionId: string): Promise<void> {
  await graphFetch(`/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: "DELETE" });
}
