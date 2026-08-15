import { Router } from "express";
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
