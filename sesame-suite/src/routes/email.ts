import { Request, Router } from "express";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import {
  getSmtpConfig,
  upsertSmtpConfig,
  sendTestEmail,
  listEmailTemplates,
  upsertEmailTemplate,
  deleteEmailTemplate,
  sendTemplatedEmail,
} from "../lib/email";

/**
 * Paramétrage SMTP + modèles d'email + envoi — endpoints génériques
 * partagés à l'identique par le CRM commercial (?scope=crm, réservé aux
 * comptes Sesame, portée globale entityId=null) et par le back-office de
 * chaque hôtel (portée par défaut, son propre entityId via resolveEntity).
 */
export const emailRouter = Router();

async function resolveScope(req: Request): Promise<string | null> {
  const scope = (req.query.scope as string) || (req.body && req.body.scope) || undefined;
  if (scope === "crm") {
    if (!req.admin || req.admin.role !== "sesame") throw new HttpError(403, "Réservé aux comptes Sesame");
    return null;
  }
  const entity = await resolveEntity(req);
  return entity.id;
}

function shapeSmtp(c: { host: string; port: number; secure: boolean; username: string; password: string; fromName: string | null; fromEmail: string } | null) {
  if (!c) return null;
  return {
    host: c.host,
    port: c.port,
    secure: c.secure,
    username: c.username,
    password: c.password,
    fromName: c.fromName || "",
    fromEmail: c.fromEmail,
  };
}

function shapeTemplate(t: { id: string; key: string; name: string; subject: string; bodyHtml: string; updatedAt: Date }) {
  return { id: t.id, key: t.key, name: t.name, subject: t.subject, bodyHtml: t.bodyHtml, updatedAt: t.updatedAt };
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
    const row = await upsertSmtpConfig(entityId, {
      host: b.host.trim(),
      port: Number(b.port),
      secure: !!b.secure,
      username: b.username.trim(),
      password: b.password,
      fromName: b.fromName,
      fromEmail: b.fromEmail.trim(),
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

emailRouter.get(
  "/emailTemplate/list",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const rows = await listEmailTemplates(entityId);
    res.json(rows.map(shapeTemplate));
  })
);

interface TemplateBody {
  key: string;
  name: string;
  subject: string;
  bodyHtml: string;
}

emailRouter.post(
  "/emailTemplate/upsert",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as TemplateBody;
    if (!b.name || !b.name.trim()) throw new HttpError(400, "Nom du modèle requis");
    if (!b.subject || !b.subject.trim()) throw new HttpError(400, "Objet requis");
    if (!b.bodyHtml || !b.bodyHtml.trim()) throw new HttpError(400, "Corps du message requis");
    const row = await upsertEmailTemplate(entityId, (b.key || "").trim().toLowerCase(), {
      name: b.name.trim(),
      subject: b.subject.trim(),
      bodyHtml: b.bodyHtml,
    });
    res.json(shapeTemplate(row));
  })
);

emailRouter.post(
  "/emailTemplate/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const id = (req.body.id as string) || "";
    await deleteEmailTemplate(entityId, id);
    res.json({ ok: true });
  })
);

interface SendBody {
  templateKey: string;
  to: string;
  variables?: Record<string, string>;
}

emailRouter.post(
  "/emailTemplate/send",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as SendBody;
    if (!b.to || !b.to.includes("@")) throw new HttpError(400, "Destinataire valide requis");
    if (!b.templateKey) throw new HttpError(400, "Modèle requis");
    const sent = await sendTemplatedEmail({ entityId, templateKey: b.templateKey, to: b.to, variables: b.variables });
    res.json({ ok: true, ...sent });
  })
);
