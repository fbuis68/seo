import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import { resolveScope } from "../lib/scope";
import { getSmtpConfig, upsertSmtpConfig, sendTestEmail } from "../lib/email";

/**
 * Paramétrage du serveur SMTP sortant (canal email) — endpoints génériques
 * partagés à l'identique par le CRM commercial (?scope=crm, réservé aux
 * comptes Sesame, portée globale entityId=null) et par le back-office de
 * chaque hôtel (portée par défaut, son propre entityId via resolveScope).
 * Les modèles et l'envoi multi-canal (email/sms/whatsapp) sont dans
 * src/routes/messaging.ts.
 */
export const emailRouter = Router();

function shapeSmtp(
  c: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
    fromName: string | null;
    fromEmail: string;
    supportFromName: string | null;
    supportFromEmail: string | null;
  } | null
) {
  if (!c) return null;
  return {
    host: c.host,
    port: c.port,
    secure: c.secure,
    username: c.username,
    password: c.password,
    fromName: c.fromName || "",
    fromEmail: c.fromEmail,
    supportFromName: c.supportFromName || "",
    supportFromEmail: c.supportFromEmail || "",
  };
}

emailRouter.get(
  "/smtpConfig/get",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    res.json(shapeSmtp(await getSmtpConfig(entityId)));
  })
);

interface SmtpBody {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromName?: string;
  fromEmail: string;
  supportFromName?: string;
  supportFromEmail?: string;
}

emailRouter.post(
  "/smtpConfig/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as SmtpBody;
    if (!b.host || !b.host.trim()) throw new HttpError(400, "Hôte SMTP requis");
    if (!b.port) throw new HttpError(400, "Port requis");
    if (!b.username || !b.username.trim()) throw new HttpError(400, "Identifiant requis");
    if (!b.password) throw new HttpError(400, "Mot de passe requis");
    if (!b.fromEmail || !b.fromEmail.includes("@")) throw new HttpError(400, "Adresse d'expédition valide requise");
    if (b.supportFromEmail && !b.supportFromEmail.includes("@")) throw new HttpError(400, "Adresse support invalide");
    const row = await upsertSmtpConfig(entityId, {
      host: b.host.trim(),
      port: Number(b.port),
      secure: !!b.secure,
      username: b.username.trim(),
      password: b.password,
      fromName: b.fromName,
      fromEmail: b.fromEmail.trim(),
      supportFromName: b.supportFromName,
      supportFromEmail: b.supportFromEmail,
    });
    res.json(shapeSmtp(row));
  })
);

emailRouter.post(
  "/smtpConfig/test",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const to = ((req.body.to as string) || "").trim();
    if (!to || !to.includes("@")) throw new HttpError(400, "Adresse de test valide requise");
    await sendTestEmail(entityId, to);
    res.json({ ok: true });
  })
);

/**
 * Identités d'expédition email (EmailSenderIdentity, 29/09/2026) — plusieurs
 * adresses "From" possibles par portée, toutes envoyées via le même relais
 * SMTP de cette portée (SmtpConfig ci-dessus) : réglées une par modèle de
 * message (MessageTemplate.senderIdentityId, cf. routes/messaging.ts),
 * utilisées automatiquement par sendMessage() pour un envoi individuel
 * comme pour une campagne utilisant ce modèle.
 */
function shapeSenderIdentity(i: { id: string; name: string; email: string }) {
  return { id: i.id, name: i.name, email: i.email };
}

emailRouter.get(
  "/emailSenderIdentity/list",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const rows = await prisma.emailSenderIdentity.findMany({ where: { entityId }, orderBy: { name: "asc" } });
    res.json(rows.map(shapeSenderIdentity));
  })
);

interface SenderIdentityBody {
  name: string;
  email: string;
}

emailRouter.post(
  "/emailSenderIdentity/create",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as SenderIdentityBody;
    if (!b.name || !b.name.trim()) throw new HttpError(400, "Nom requis");
    if (!b.email || !b.email.includes("@")) throw new HttpError(400, "Adresse email valide requise");
    const existing = await prisma.emailSenderIdentity.findFirst({ where: { entityId, email: b.email.trim().toLowerCase() } });
    if (existing) throw new HttpError(400, "Cette adresse existe déjà");
    const row = await prisma.emailSenderIdentity.create({
      data: { entityId, name: b.name.trim(), email: b.email.trim().toLowerCase() },
    });
    res.status(201).json(shapeSenderIdentity(row));
  })
);

emailRouter.post(
  "/emailSenderIdentity/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const id = (req.body.id as string) || "";
    const b = req.body as SenderIdentityBody;
    const existing = await prisma.emailSenderIdentity.findFirst({ where: { id, entityId } });
    if (!existing) throw new HttpError(404, "Adresse d'expédition introuvable");
    if (!b.name || !b.name.trim()) throw new HttpError(400, "Nom requis");
    if (!b.email || !b.email.includes("@")) throw new HttpError(400, "Adresse email valide requise");
    const email = b.email.trim().toLowerCase();
    if (email !== existing.email) {
      const dup = await prisma.emailSenderIdentity.findFirst({ where: { entityId, email, id: { not: id } } });
      if (dup) throw new HttpError(400, "Cette adresse existe déjà");
    }
    const row = await prisma.emailSenderIdentity.update({ where: { id }, data: { name: b.name.trim(), email } });
    res.json(shapeSenderIdentity(row));
  })
);

emailRouter.post(
  "/emailSenderIdentity/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const id = (req.body.id as string) || "";
    const existing = await prisma.emailSenderIdentity.findFirst({ where: { id, entityId } });
    if (!existing) throw new HttpError(404, "Adresse d'expédition introuvable");
    // Les modèles qui pointaient sur cette identité retombent sur l'adresse
    // par défaut de la config SMTP (onDelete: SetNull côté schéma).
    await prisma.emailSenderIdentity.delete({ where: { id } });
    res.json({ ok: true });
  })
);
