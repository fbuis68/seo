import { prisma } from "../db";
import { HttpError } from "./asyncHandler";

/**
 * Canaux SMS et WhatsApp — un seul fournisseur (Twilio), dont l'API REST
 * couvre les deux canaux avec les mêmes identifiants de compte (Account
 * SID + Auth Token), seul le numéro expéditeur diffère. C'est ce qui rend
 * la convergence SMS/WhatsApp possible sans intégration séparée par canal.
 * Appel HTTP direct (pas de SDK Twilio) — l'API Messages est un simple
 * POST form-encodé avec authentification Basic.
 */

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
const SMSPARTNER_API_BASE = "https://api.smspartner.fr/v1";

export type SmsChannel = "sms" | "whatsapp";

// Voir le commentaire équivalent dans src/lib/email.ts : PostgreSQL ne
// garantit pas l'unicité entre lignes entityId=NULL (portée CRM globale),
// donc lecture/écriture doivent être déterministes (orderBy) et l'upsert
// doit nettoyer les doublons éventuels plutôt que de risquer d'en créer.
export async function getChannelConfig(entityId: string | null, channel: SmsChannel) {
  return prisma.channelConfig.findFirst({ where: { entityId, channel }, orderBy: { updatedAt: "desc" } });
}

export async function upsertChannelConfig(
  entityId: string | null,
  channel: SmsChannel,
  data: { provider?: string; accountSid?: string; authToken?: string; fromNumber?: string; apiKey?: string; baseUrl?: string }
) {
  // Le provider change la forme des identifiants stockés (SID+Token pour
  // Twilio, une seule clé pour DocPartner/SMSPartner/Infobip) : on réécrit
  // toujours la ligne complète pour éviter qu'un changement de provider ne
  // laisse des identifiants de l'ancien provider traîner dans la ligne.
  const payload = {
    provider: data.provider || "twilio",
    accountSid: data.accountSid ?? null,
    authToken: data.authToken ?? null,
    fromNumber: data.fromNumber ?? null,
    apiKey: data.apiKey ?? null,
    baseUrl: data.baseUrl ?? null,
  };
  const existingRows = await prisma.channelConfig.findMany({ where: { entityId, channel }, orderBy: { updatedAt: "desc" } });
  if (existingRows.length > 0) {
    const [primary, ...duplicates] = existingRows;
    if (duplicates.length) {
      await prisma.channelConfig.deleteMany({ where: { id: { in: duplicates.map((d) => d.id) } } });
    }
    return prisma.channelConfig.update({ where: { id: primary.id }, data: payload });
  }
  return prisma.channelConfig.create({ data: { entityId, channel, ...payload } });
}

async function sendViaTwilio(
  cfg: { accountSid: string | null; authToken: string | null; fromNumber: string | null },
  to: string,
  body: string,
  channel: SmsChannel
) {
  if (!cfg.accountSid || !cfg.authToken || !cfg.fromNumber) {
    throw new HttpError(400, `Configuration ${channel === "whatsapp" ? "WhatsApp" : "SMS"} incomplète (identifiants Twilio manquants)`);
  }
  const toAddr = channel === "whatsapp" ? (to.startsWith("whatsapp:") ? to : `whatsapp:${to}`) : to;
  const fromAddr = channel === "whatsapp" && !cfg.fromNumber.startsWith("whatsapp:") ? `whatsapp:${cfg.fromNumber}` : cfg.fromNumber;

  const url = `${TWILIO_API_BASE}/Accounts/${cfg.accountSid}/Messages.json`;
  const params = new URLSearchParams({ To: toAddr, From: fromAddr, Body: body });
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
  } catch (err) {
    throw new HttpError(502, "Échec de connexion à l'API Twilio : " + String(err instanceof Error ? err.message : err));
  }

  if (!res.ok) {
    let detail: string;
    try {
      // Twilio renvoie systématiquement un code numérique ("code") en plus du
      // message texte — jusqu'ici ignoré, alors qu'il identifie précisément la
      // restriction en cause (cf. table des codes sur www.twilio.com/docs/errors/<code>).
      // Nécessaire pour diagnostiquer sans deviner : un message Twilio du type
      // "not available on a Trial account" peut recouvrir plusieurs causes
      // distinctes (compte non vérifié, expéditeur non autorisé, sandbox WhatsApp
      // non "join", etc.) que seul le code numérique désambiguïse.
      const j = (await res.json()) as { message?: string; code?: number; more_info?: string };
      if (j.message) {
        detail = j.message;
        if (j.code) detail += ` [code Twilio ${j.code}]`;
        if (j.more_info) detail += ` — voir ${j.more_info}`;
      } else {
        detail = JSON.stringify(j);
      }
    } catch {
      detail = await res.text();
    }
    throw new HttpError(502, `Échec de l'envoi Twilio (HTTP ${res.status}) : ${detail}`);
  }
}

/**
 * Envoi WhatsApp via un Content Template Twilio pré-approuvé par Meta
 * (ContentSid), seul moyen d'envoyer un message business-initié en dehors
 * d'une fenêtre de session client de 24h — cf. commentaire sur
 * MessageTemplate.whatsappContentSid. contentVariables est l'objet attendu
 * par Twilio, ex. {"1":"Dupont","2":"12h00"} (les variables numérotées du
 * modèle approuvé, dans l'ordre où {{var}} apparaît dans notre bodyHtml).
 */
async function sendViaTwilioTemplate(
  cfg: { accountSid: string | null; authToken: string | null; fromNumber: string | null },
  to: string,
  contentSid: string,
  contentVariables: Record<string, string>
) {
  if (!cfg.accountSid || !cfg.authToken || !cfg.fromNumber) {
    throw new HttpError(400, "Configuration WhatsApp incomplète (identifiants Twilio manquants)");
  }
  const toAddr = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
  const fromAddr = cfg.fromNumber.startsWith("whatsapp:") ? cfg.fromNumber : `whatsapp:${cfg.fromNumber}`;

  const url = `${TWILIO_API_BASE}/Accounts/${cfg.accountSid}/Messages.json`;
  const params = new URLSearchParams({
    To: toAddr,
    From: fromAddr,
    ContentSid: contentSid,
    ContentVariables: JSON.stringify(contentVariables),
  });
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
  } catch (err) {
    throw new HttpError(502, "Échec de connexion à l'API Twilio : " + String(err instanceof Error ? err.message : err));
  }

  if (!res.ok) {
    let detail: string;
    try {
      const j = (await res.json()) as { message?: string; code?: number; more_info?: string };
      if (j.message) {
        detail = j.message;
        if (j.code) detail += ` [code Twilio ${j.code}]`;
        if (j.more_info) detail += ` — voir ${j.more_info}`;
      } else {
        detail = JSON.stringify(j);
      }
    } catch {
      detail = await res.text();
    }
    throw new HttpError(502, `Échec de l'envoi Twilio (HTTP ${res.status}) : ${detail}`);
  }
}

/** Envoi WhatsApp par Content Template Twilio, appelé par messaging.ts. */
export async function sendWhatsAppTemplate(entityId: string | null, to: string, contentSid: string, contentVariables: Record<string, string>) {
  const cfg = await getChannelConfig(entityId, "whatsapp");
  if (!cfg) throw new HttpError(400, "Aucune configuration WhatsApp pour cette portée");
  if (cfg.provider === "infobip" || cfg.provider === "meta") {
    // contentVariables est numéroté ("1","2",...) pour matcher le format
    // Twilio (ContentVariables) — Infobip et Meta attendent un tableau
    // positionnel, reconstruit ici dans l'ordre plutôt que de dupliquer
    // cette logique côté messaging.ts pour chaque provider.
    const placeholders = Object.keys(contentVariables)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => contentVariables[k]);
    if (cfg.provider === "meta") {
      await sendViaMetaTemplate(cfg, to, contentSid, placeholders);
    } else {
      await sendViaInfobipTemplate(cfg, to, contentSid, placeholders);
    }
    return;
  }
  await sendViaTwilioTemplate(cfg, to, contentSid, contentVariables);
}

/**
 * DocPartner / SMSPartner.fr — partenaire SMS de Sesame Technology, intégré
 * le 18/08/2026 à partir de la documentation officielle fournie par
 * l'utilisateur (api.smspartner.fr/v1, endpoint /send). SMS uniquement, pas
 * de canal WhatsApp chez ce partenaire. Authentification par une clé API
 * unique passée dans le corps JSON — pas de couple SID/Token ni de header
 * Authorization comme chez Twilio, d'où un client HTTP distinct.
 */
async function sendViaSmsPartner(cfg: { apiKey: string | null; fromNumber: string | null }, to: string, body: string) {
  if (!cfg.apiKey) {
    throw new HttpError(400, "Configuration SMS incomplète (clé API DocPartner manquante)");
  }
  const payload: Record<string, unknown> = { apiKey: cfg.apiKey, phoneNumbers: to, message: body };
  if (cfg.fromNumber) payload.sender = cfg.fromNumber;

  let res: Response;
  try {
    res = await fetch(`${SMSPARTNER_API_BASE}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new HttpError(502, "Échec de connexion à l'API DocPartner : " + String(err instanceof Error ? err.message : err));
  }

  // Lu en texte une seule fois puis parsé manuellement (plutôt que
  // res.json() + catch → res.text() sur le corps déjà consommé, qui lève
  // "body used already" si le JSON est invalide) : l'API renvoie du JSON
  // structuré dans tous les cas documentés, mais on reste tolérant.
  const text = await res.text();
  let j: { success?: boolean; code?: number; message_id?: number; errors?: { elementId?: string; message?: string }[] } = {};
  try {
    j = JSON.parse(text);
  } catch {
    // corps non-JSON, géré ci-dessous via `text` brut
  }

  if (!res.ok || j.success === false) {
    const detail = j.errors?.length
      ? j.errors
          .map((e) => e.message)
          .filter(Boolean)
          .join(" ; ")
      : j.code !== undefined
        ? `code DocPartner ${j.code}`
        : text || `HTTP ${res.status}`;
    throw new HttpError(502, `Échec de l'envoi DocPartner (HTTP ${res.status}) : ${detail}`);
  }
}

const INFOBIP_SMS_PATH = "/sms/2/text/advanced";
const INFOBIP_WHATSAPP_TEXT_PATH = "/whatsapp/1/message/text";
const INFOBIP_WHATSAPP_TEMPLATE_PATH = "/whatsapp/1/message/template";

function infobipBaseUrl(cfg: { baseUrl: string | null }): string {
  if (!cfg.baseUrl) throw new HttpError(400, "Configuration incomplète (sous-domaine de compte Infobip manquant)");
  const trimmed = cfg.baseUrl.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return `https://${trimmed}`;
}

/**
 * Infobip et Meta (WhatsApp Cloud API) attendent tous deux un MSISDN brut
 * (indicatif + numéro, chiffres uniquement — ex. "447860088970"), sans "+"
 * ni espaces ; Infobip rejette en plus tout expéditeur qui ne correspond pas
 * EXACTEMENT à l'expéditeur tel qu'enregistré sur le compte ("Invalid Source
 * address" / REJECTED_SOURCE) même si le numéro "+44 7860 088970" désigne le
 * même expéditeur — confirmé le 09/09/2026 via une capture réseau Infobip
 * (l'expéditeur "447860088970" était pourtant bien actif côté portail
 * Infobip). Les champs "Numéro expéditeur"/"to" de ce projet acceptent le
 * format E.164 habituel (+33612345678) pour rester cohérents avec
 * Twilio/DocPartner — cette fonction fait la conversion uniquement pour les
 * appels vers ces API.
 */
function toMsisdn(n: string): string {
  return n.replace(/[^0-9]/g, "");
}

/**
 * Infobip — SMS + WhatsApp sous un seul compte/API (contrairement à
 * DocPartner, SMS uniquement), intégré le 09/09/2026 d'après la
 * documentation officielle Infobip (api.infobip.com). Authentification par
 * clé API unique (en-tête Authorization: App <clé>, distinct du couple
 * SID/Token Twilio). L'URL d'API est propre à chaque compte (sous-domaine
 * attribué à la création, cf. ChannelConfig.baseUrl) — contrairement à
 * Twilio/DocPartner dont l'URL est fixe pour tous les clients.
 */
async function infobipRequest(cfg: { apiKey: string | null; baseUrl: string | null }, path: string, payload: unknown) {
  if (!cfg.apiKey) throw new HttpError(400, "Configuration incomplète (clé API Infobip manquante)");
  const url = `${infobipBaseUrl(cfg)}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `App ${cfg.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new HttpError(502, "Échec de connexion à l'API Infobip : " + String(err instanceof Error ? err.message : err));
  }
  const text = await res.text();
  let j: { messages?: { status?: { groupId?: number; name?: string; description?: string } }[]; requestError?: { serviceException?: { messageId?: string; text?: string } } } = {};
  try {
    j = JSON.parse(text);
  } catch {
    // corps non-JSON, géré ci-dessous via `text` brut
  }
  if (!res.ok) {
    const detail = j.requestError?.serviceException?.text || j.requestError?.serviceException?.messageId || text || `HTTP ${res.status}`;
    throw new HttpError(502, `Échec de l'envoi Infobip (HTTP ${res.status}) : ${detail}`);
  }
  // Un envoi accepté (HTTP 200) peut quand même contenir un message
  // individuel en échec (numéro invalide, expéditeur non autorisé...) — cf.
  // messages[].status.groupId dans la réponse Infobip (1-2 = en cours/livré,
  // 3+ = échec/rejeté/en attente d'expiration).
  const status = j.messages?.[0]?.status;
  if (status && typeof status.groupId === "number" && status.groupId >= 3) {
    throw new HttpError(502, `Échec de l'envoi Infobip : ${status.name || status.description || "statut " + status.groupId}`);
  }
}

async function sendViaInfobip(
  cfg: { apiKey: string | null; fromNumber: string | null; baseUrl: string | null },
  to: string,
  body: string,
  channel: SmsChannel
) {
  if (!cfg.fromNumber) {
    throw new HttpError(400, `Configuration ${channel === "whatsapp" ? "WhatsApp" : "SMS"} incomplète (expéditeur Infobip manquant)`);
  }
  if (channel === "whatsapp") {
    await infobipRequest(cfg, INFOBIP_WHATSAPP_TEXT_PATH, {
      from: toMsisdn(cfg.fromNumber),
      to: toMsisdn(to),
      content: { text: body },
    });
  } else {
    await infobipRequest(cfg, INFOBIP_SMS_PATH, {
      messages: [{ destinations: [{ to: toMsisdn(to) }], from: toMsisdn(cfg.fromNumber), text: body }],
    });
  }
}

/**
 * Envoi WhatsApp via un template Infobip pré-approuvé par Meta — même
 * principe que sendViaTwilioTemplate (Content Template Twilio), avec une
 * forme de requête différente : templateName + langue + variables
 * POSITIONNELLES (tableau), pas un objet numéroté comme ContentVariables
 * chez Twilio. MessageTemplate.whatsappContentSid est réutilisé pour
 * stocker le nom du template Infobip (libellé adapté côté UI selon le
 * provider choisi) plutôt que d'ajouter un champ dédié.
 */
async function sendViaInfobipTemplate(
  cfg: { apiKey: string | null; fromNumber: string | null; baseUrl: string | null },
  to: string,
  templateName: string,
  placeholders: string[]
) {
  if (!cfg.fromNumber) throw new HttpError(400, "Configuration WhatsApp incomplète (expéditeur Infobip manquant)");
  await infobipRequest(cfg, INFOBIP_WHATSAPP_TEMPLATE_PATH, {
    messages: [
      {
        from: toMsisdn(cfg.fromNumber),
        to: toMsisdn(to),
        content: {
          templateName,
          // Langue du template tel qu'approuvé côté Meta/Infobip — "fr" par
          // défaut (marché de cette app), pas encore configurable par
          // modèle : à ajuster si un établissement a besoin d'une autre
          // langue de template WhatsApp.
          language: "fr",
          templateData: { body: { placeholders } },
        },
      },
    ],
  });
}

const META_GRAPH_API_BASE = "https://graph.facebook.com/v21.0";

/**
 * Meta WhatsApp Cloud API — connecteur "direct" (compte développeur
 * Facebook/Meta, sans intermédiaire Twilio/Infobip), ajouté le 11/09/2026 à
 * la demande de l'utilisateur. Deux identifiants suffisent, stockés dans les
 * colonnes génériques déjà en place : ChannelConfig.apiKey porte le jeton
 * d'accès (System User token, permanent) et ChannelConfig.fromNumber porte
 * le "Phone Number ID" Meta — un identifiant interne Meta, PAS le numéro de
 * téléphone lui-même — qui figure dans l'URL de chaque appel. Pas de
 * baseUrl : l'URL de l'API Graph est fixe pour tous les comptes.
 */
async function metaRequest(cfg: { apiKey: string | null; fromNumber: string | null }, payload: unknown) {
  if (!cfg.apiKey) throw new HttpError(400, "Configuration WhatsApp incomplète (jeton d'accès Meta manquant)");
  if (!cfg.fromNumber) throw new HttpError(400, "Configuration WhatsApp incomplète (ID du numéro de téléphone Meta manquant)");
  const url = `${META_GRAPH_API_BASE}/${cfg.fromNumber}/messages`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new HttpError(502, "Échec de connexion à l'API Meta (WhatsApp Cloud) : " + String(err instanceof Error ? err.message : err));
  }
  const text = await res.text();
  let j: { error?: { message?: string; code?: number; error_subcode?: number; error_user_msg?: string } } = {};
  try {
    j = JSON.parse(text);
  } catch {
    // corps non-JSON, géré ci-dessous via `text` brut
  }
  if (!res.ok) {
    const e = j.error;
    const detail = e?.error_user_msg || e?.message || text || `HTTP ${res.status}`;
    const code = e?.code !== undefined ? ` [code Meta ${e.code}${e.error_subcode ? "." + e.error_subcode : ""}]` : "";
    throw new HttpError(502, `Échec de l'envoi Meta (HTTP ${res.status}) : ${detail}${code}`);
  }
}

async function sendViaMeta(cfg: { apiKey: string | null; fromNumber: string | null }, to: string, body: string) {
  await metaRequest(cfg, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toMsisdn(to),
    type: "text",
    text: { body },
  });
}

/**
 * Envoi WhatsApp via un template Meta pré-approuvé (Meta Business Manager) —
 * même principe que sendViaInfobipTemplate/sendViaTwilioTemplate, requis en
 * dehors d'une fenêtre de session client de 24h. MessageTemplate.whatsappContentSid
 * est réutilisé pour stocker le nom du template Meta (libellé adapté côté UI
 * selon le provider choisi) plutôt que d'ajouter un champ dédié.
 */
async function sendViaMetaTemplate(
  cfg: { apiKey: string | null; fromNumber: string | null },
  to: string,
  templateName: string,
  placeholders: string[]
) {
  await metaRequest(cfg, {
    messaging_product: "whatsapp",
    to: toMsisdn(to),
    type: "template",
    template: {
      name: templateName,
      // Langue du template tel qu'approuvé côté Meta — "fr" par défaut
      // (marché de cette app), pas encore configurable par modèle.
      language: { code: "fr" },
      components: placeholders.length ? [{ type: "body", parameters: placeholders.map((text) => ({ type: "text", text })) }] : [],
    },
  });
}

async function sendViaProvider(
  cfg: { provider: string; accountSid: string | null; authToken: string | null; fromNumber: string | null; apiKey: string | null; baseUrl: string | null },
  to: string,
  body: string,
  channel: SmsChannel
) {
  if (channel === "sms" && cfg.provider === "smspartner") {
    await sendViaSmsPartner(cfg, to, body);
    return;
  }
  if (cfg.provider === "infobip") {
    await sendViaInfobip(cfg, to, body, channel);
    return;
  }
  if (channel === "whatsapp" && cfg.provider === "meta") {
    await sendViaMeta(cfg, to, body);
    return;
  }
  await sendViaTwilio(cfg, to, body, channel);
}

export async function sendTestMessage(entityId: string | null, channel: SmsChannel, to: string) {
  const cfg = await getChannelConfig(entityId, channel);
  if (!cfg) throw new HttpError(400, `Aucune configuration ${channel === "whatsapp" ? "WhatsApp" : "SMS"} pour cette portée`);
  await sendViaProvider(cfg, to, `Sesame Suite — test de configuration ${channel === "whatsapp" ? "WhatsApp" : "SMS"}.`, channel);
}

/** Envoi brut, appelé par messaging.ts après rendu du modèle. */
export async function sendChannelRaw(entityId: string | null, channel: SmsChannel, to: string, body: string) {
  const cfg = await getChannelConfig(entityId, channel);
  if (!cfg) throw new HttpError(400, `Aucune configuration ${channel === "whatsapp" ? "WhatsApp" : "SMS"} pour cette portée`);
  await sendViaProvider(cfg, to, body, channel);
}
