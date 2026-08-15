import { Router } from "express";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import { resolveScope } from "../lib/scope";
import { getChannelConfig, upsertChannelConfig, sendTestMessage, SmsChannel } from "../lib/sms";
import { listMessageTemplates, upsertMessageTemplate, deleteMessageTemplate, Channel } from "../lib/messageTemplate";
import { sendMessage } from "../lib/messaging";

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

function shapeChannelConfig(c: { accountSid: string | null; authToken: string | null; fromNumber: string | null } | null) {
  if (!c) return null;
  return { accountSid: c.accountSid || "", authToken: c.authToken || "", fromNumber: c.fromNumber || "" };
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
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

messagingRouter.post(
  "/channelConfig/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as ChannelConfigBody;
    if (!isSmsChannel(b.channel)) throw new HttpError(400, "channel doit être sms ou whatsapp");
    if (!b.accountSid || !b.accountSid.trim()) throw new HttpError(400, "Account SID requis");
    if (!b.authToken) throw new HttpError(400, "Auth Token requis");
    if (!b.fromNumber || !b.fromNumber.trim()) throw new HttpError(400, "Numéro expéditeur requis");
    const row = await upsertChannelConfig(entityId, b.channel, {
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

function shapeTemplate(t: { id: string; channel: string; key: string; name: string; subject: string; bodyHtml: string; updatedAt: Date }) {
  return { id: t.id, channel: t.channel, key: t.key, name: t.name, subject: t.subject, bodyHtml: t.bodyHtml, updatedAt: t.updatedAt };
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
    const row = await upsertMessageTemplate(entityId, b.channel, (b.key || "").trim().toLowerCase(), {
      name: b.name.trim(),
      subject: (b.subject || "").trim(),
      bodyHtml: b.bodyHtml,
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
    const sent = await sendMessage({ entityId, channel: b.channel, templateKey: b.templateKey, to: b.to, variables: b.variables });
    res.json({ ok: true, ...sent });
  })
);
