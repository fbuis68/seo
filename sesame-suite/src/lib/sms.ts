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
  data: { provider?: string; accountSid?: string; authToken?: string; fromNumber?: string; apiKey?: string }
) {
  // Le provider change la forme des identifiants stockés (SID+Token pour
  // Twilio, une seule clé pour DocPartner/SMSPartner) : on réécrit toujours
  // la ligne complète pour éviter qu'un changement de provider ne laisse des
  // identifiants de l'ancien provider traîner dans la ligne.
  const payload = {
    provider: data.provider || "twilio",
    accountSid: data.accountSid ?? null,
    authToken: data.authToken ?? null,
    fromNumber: data.fromNumber ?? null,
    apiKey: data.apiKey ?? null,
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

async function sendViaProvider(
  cfg: { provider: string; accountSid: string | null; authToken: string | null; fromNumber: string | null; apiKey: string | null },
  to: string,
  body: string,
  channel: SmsChannel
) {
  if (channel === "sms" && cfg.provider === "smspartner") {
    await sendViaSmsPartner(cfg, to, body);
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
