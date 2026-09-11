import { Router } from "express";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import { resolveScope } from "../lib/scope";
import { getChannelConfig, upsertChannelConfig, sendTestMessage, SmsChannel } from "../lib/sms";
import { listMessageTemplates, upsertMessageTemplate, deleteMessageTemplate, Channel } from "../lib/messageTemplate";
import { sendMessage } from "../lib/messaging";
import { createMetaMessageTemplate, listMetaMessageTemplates } from "../lib/metaTemplates";

/**
 * Config des canaux SMS/WhatsApp (Twilio), modèles de message multi-canal,
 * et envoi générique — mêmes endpoints partagés par le CRM (?scope=crm) et
 * le back-office de chaque hôtel (portée par défaut). Le SMTP email a ses
 * propres endpoints dans src/routes/email.ts ; celui-ci couvre le reste de
 * la convergence multi-canal (modèles + sms + whatsapp + envoi).
 */
export const messagingRouter = Router();

function isSmsChannel(v: unknown): v is SmsChannel {
  return v === "sms" || v === "whatsapp";
}
function isChannel(v: unknown): v is Channel {
  return v === "email" || v === "sms" || v === "whatsapp";
}

function shapeChannelConfig(
  c: {
    provider: string;
    accountSid: string | null;
    authToken: string | null;
    fromNumber: string | null;
    apiKey: string | null;
    baseUrl: string | null;
  } | null
) {
  if (!c) return null;
  return {
    provider: c.provider || "twilio",
    accountSid: c.accountSid || "",
    authToken: c.authToken || "",
    fromNumber: c.fromNumber || "",
    apiKey: c.apiKey || "",
    baseUrl: c.baseUrl || "",
  };
}

messagingRouter.get(
  "/channelConfig/get",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const channel = req.query.channel;
    if (!isSmsChannel(channel)) throw new HttpError(400, "channel doit être sms ou whatsapp");
    res.json(shapeChannelConfig(await getChannelConfig(entityId, channel)));
  })
);

interface ChannelConfigBody {
  channel: string;
  provider?: string;
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
  apiKey?: string;
  baseUrl?: string;
}

messagingRouter.post(
  "/channelConfig/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as ChannelConfigBody;
    if (!isSmsChannel(b.channel)) throw new HttpError(400, "channel doit être sms ou whatsapp");
    // DocPartner/SMSPartner ne couvre que le SMS, pas le WhatsApp — un choix
    // de provider "smspartner" sur le canal whatsapp retombe sur Twilio.
    // Infobip couvre les deux canaux (comme Twilio), donc pas cette
    // restriction pour lui. Meta (WhatsApp Cloud API, compte développeur
    // Facebook) ne couvre que le WhatsApp — un choix "meta" sur le canal sms
    // retombe sur Twilio, comme smspartner sur whatsapp.
    const provider =
      b.provider === "smspartner" && b.channel === "sms"
        ? "smspartner"
        : b.provider === "infobip"
          ? "infobip"
          : b.provider === "meta" && b.channel === "whatsapp"
            ? "meta"
            : "twilio";
    if (provider === "smspartner") {
      if (!b.apiKey || !b.apiKey.trim()) throw new HttpError(400, "Clé API DocPartner requise");
      const row = await upsertChannelConfig(entityId, b.channel, {
        provider,
        apiKey: b.apiKey.trim(),
        fromNumber: (b.fromNumber || "").trim(),
      });
      res.json(shapeChannelConfig(row));
      return;
    }
    if (provider === "meta") {
      if (!b.apiKey || !b.apiKey.trim()) throw new HttpError(400, "Jeton d'accès Meta requis");
      if (!b.fromNumber || !b.fromNumber.trim()) throw new HttpError(400, "ID du numéro de téléphone Meta requis");
      // L'ID du compte WhatsApp Business (WABA) réutilise ChannelConfig.baseUrl
      // (inutilisé par le provider Meta pour l'envoi lui-même — seul l'envoi de
      // messages a besoin de apiKey+fromNumber). Optionnel à l'enregistrement
      // pour ne pas bloquer une config déjà fonctionnelle pour l'envoi ; requis
      // uniquement au moment de créer un modèle (cf. metaTemplates.ts).
      const row = await upsertChannelConfig(entityId, b.channel, {
        provider,
        apiKey: b.apiKey.trim(),
        fromNumber: b.fromNumber.trim(),
        baseUrl: (b.baseUrl || "").trim(),
      });
      res.json(shapeChannelConfig(row));
      return;
    }
    if (provider === "infobip") {
      if (!b.apiKey || !b.apiKey.trim()) throw new HttpError(400, "Clé API Infobip requise");
      if (!b.baseUrl || !b.baseUrl.trim()) throw new HttpError(400, "Sous-domaine de compte Infobip requis (ex : xxxxx.api.infobip.com)");
      if (!b.fromNumber || !b.fromNumber.trim()) throw new HttpError(400, "Expéditeur requis");
      const row = await upsertChannelConfig(entityId, b.channel, {
        provider,
        apiKey: b.apiKey.trim(),
        fromNumber: b.fromNumber.trim(),
        baseUrl: b.baseUrl.trim(),
      });
      res.json(shapeChannelConfig(row));
      return;
    }
    if (!b.accountSid || !b.accountSid.trim()) throw new HttpError(400, "Account SID requis");
    if (!b.authToken) throw new HttpError(400, "Auth Token requis");
    if (!b.fromNumber || !b.fromNumber.trim()) throw new HttpError(400, "Numéro expéditeur requis");
    const row = await upsertChannelConfig(entityId, b.channel, {
      provider,
      accountSid: b.accountSid.trim(),
      authToken: b.authToken,
      fromNumber: b.fromNumber.trim(),
    });
    res.json(shapeChannelConfig(row));
  })
);

messagingRouter.post(
  "/channelConfig/test",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const channel = req.body.channel;
    const to = ((req.body.to as string) || "").trim();
    if (!isSmsChannel(channel)) throw new HttpError(400, "channel doit être sms ou whatsapp");
    if (!to) throw new HttpError(400, "Destinataire de test requis");
    await sendTestMessage(entityId, channel, to);
    res.json({ ok: true });
  })
);

/**
 * Création/consultation de modèles WhatsApp directement chez Meta, sans
 * passer par l'interface Meta Business Manager — réservé au provider
 * "meta" (Twilio et Infobip n'exposent pas cette API depuis Sesame Suite,
 * leurs modèles restent créés dans leurs consoles respectives). Le corps
 * soumis à Meta réutilise le bodyHtml déjà saisi dans l'éditeur de modèle
 * Sesame Suite, avec ses {{var}} nommés convertis en emplacements
 * positionnels {{1}}, {{2}}... (cf. toMetaTemplateBody) — le nom retourné
 * est ensuite à coller dans MessageTemplate.whatsappContentSid comme pour
 * un modèle créé manuellement chez Meta.
 */
messagingRouter.post(
  "/metaTemplate/create",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const cfg = await getChannelConfig(entityId, "whatsapp");
    if (!cfg || cfg.provider !== "meta") throw new HttpError(400, "Le canal WhatsApp n'est pas configuré avec le provider Meta");
    const b = req.body as { name?: string; category?: string; bodyHtml?: string };
    if (!b.name || !b.name.trim()) throw new HttpError(400, "Nom du modèle requis");
    if (!b.bodyHtml || !b.bodyHtml.trim()) throw new HttpError(400, "Corps du message requis");
    const result = await createMetaMessageTemplate(cfg, { name: b.name, category: b.category || "UTILITY", bodyHtml: b.bodyHtml });
    res.json(result);
  })
);

messagingRouter.get(
  "/metaTemplate/list",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const cfg = await getChannelConfig(entityId, "whatsapp");
    if (!cfg || cfg.provider !== "meta") {
      res.json([]);
      return;
    }
    const rows = await listMetaMessageTemplates(cfg);
    res.json(rows);
  })
);

function shapeTemplate(t: {
  id: string;
  channel: string;
  key: string;
  name: string;
  subject: string;
  bodyHtml: string;
  whatsappContentSid: string | null;
  updatedAt: Date;
}) {
  return {
    id: t.id,
    channel: t.channel,
    key: t.key,
    name: t.name,
    subject: t.subject,
    bodyHtml: t.bodyHtml,
    whatsappContentSid: t.whatsappContentSid || "",
    updatedAt: t.updatedAt,
  };
}

messagingRouter.get(
  "/messageTemplate/list",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const channel = req.query.channel;
    const rows = await listMessageTemplates(entityId, isChannel(channel) ? channel : undefined);
    res.json(rows.map(shapeTemplate));
  })
);

interface TemplateBody {
  channel: string;
  key: string;
  name: string;
  subject: string;
  bodyHtml: string;
  whatsappContentSid?: string;
}

messagingRouter.post(
  "/messageTemplate/upsert",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as TemplateBody;
    if (!isChannel(b.channel)) throw new HttpError(400, "channel doit être email, sms ou whatsapp");
    if (!b.name || !b.name.trim()) throw new HttpError(400, "Nom du modèle requis");
    if (b.channel === "email" && (!b.subject || !b.subject.trim())) throw new HttpError(400, "Objet requis pour un modèle email");
    if (!b.bodyHtml || !b.bodyHtml.trim()) throw new HttpError(400, "Corps du message requis");
    // WhatsApp Business interdit le texte libre business-initié en dehors
    // d'une session client de 24h (règle Meta) — un modèle WhatsApp doit
    // donc toujours pointer vers un Content Template approuvé, sans quoi
    // l'envoi échouerait de toute façon (cf. src/lib/messaging.ts).
    if (b.channel === "whatsapp" && (!b.whatsappContentSid || !b.whatsappContentSid.trim())) {
      throw new HttpError(400, "Content SID Twilio requis pour un modèle WhatsApp (créez-le d'abord dans Twilio Content Template Builder, faites-le approuver, puis collez son SID ici)");
    }
    const row = await upsertMessageTemplate(entityId, b.channel, (b.key || "").trim().toLowerCase(), {
      name: b.name.trim(),
      subject: (b.subject || "").trim(),
      bodyHtml: b.bodyHtml,
      whatsappContentSid: b.channel === "whatsapp" ? (b.whatsappContentSid || "").trim() : "",
    });
    res.json(shapeTemplate(row));
  })
);

messagingRouter.post(
  "/messageTemplate/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const id = (req.body.id as string) || "";
    await deleteMessageTemplate(entityId, id);
    res.json({ ok: true });
  })
);

interface SendBody {
  channel: string;
  templateKey: string;
  to: string;
  variables?: Record<string, string>;
  /** Portée CRM uniquement — cf. sendMessage() trackOpenProspectId (score d'intérêt, +1 à l'ouverture). */
  prospectId?: string;
}

messagingRouter.post(
  "/message/send",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as SendBody;
    if (!isChannel(b.channel)) throw new HttpError(400, "channel doit être email, sms ou whatsapp");
    if (!b.to) throw new HttpError(400, "Destinataire requis");
    if (!b.templateKey) throw new HttpError(400, "Modèle requis");
    const sent = await sendMessage({
      entityId,
      channel: b.channel,
      templateKey: b.templateKey,
      to: b.to,
      variables: b.variables,
      trackOpenProspectId: entityId === null ? b.prospectId : undefined,
      baseUrl: `${req.protocol}://${req.get("host")}`,
    });
    res.json({ ok: true, ...sent });
  })
);
