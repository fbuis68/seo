import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { verifyUnsubscribeToken } from "../lib/unsubscribeToken";

/**
 * Désabonnement newsletter/campagnes — endpoint public (pas de session
 * possible depuis un client mail), sécurisé par un jeton signé plutôt que
 * par une authentification (cf. lib/unsubscribeToken.ts). Volontairement
 * en dehors de la convention /wa/<entité>/<action> CRUD : ce n'est pas une
 * ressource mais une action ponctuelle déclenchée par un clic.
 */
export const unsubscribeRouter = Router();

function page(title: string, message: string) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
body{margin:0;background:#f4f6f9;font-family:'Segoe UI',Arial,sans-serif;color:#0e2841;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
.card{background:#fff;border-radius:12px;max-width:420px;width:100%;padding:32px 28px;text-align:center;box-shadow:0 4px 24px rgba(0,34,68,0.08)}
h1{font-size:18px;margin:0 0 12px;color:#002244}
p{font-size:14px;line-height:1.5;margin:0;color:#333}
.bar{height:4px;width:48px;background:#002244;border-radius:2px;margin:0 auto 20px}
</style></head><body><div class="card"><div class="bar"></div><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

unsubscribeRouter.get(
  "/wa/unsubscribe",
  asyncHandler(async (req, res) => {
    const token = (req.query.token as string) || "";
    const parsed = token ? verifyUnsubscribeToken(token) : null;
    if (!parsed) {
      res.status(400).send(page("Lien invalide", "Ce lien de désabonnement n'est plus valide. Contactez-nous si vous souhaitez ne plus recevoir nos communications."));
      return;
    }

    if (parsed.entityId === null) {
      // Plusieurs fiches CRM peuvent partager le même email (rare mais
      // possible) — on les désabonne toutes plutôt que de choisir laquelle
      // est "la bonne", cf. updateMany.
      await prisma.crmProspect.updateMany({
        where: { entityId: null, email: { equals: parsed.target, mode: "insensitive" } },
        data: { emailOptOut: true, emailOptOutAt: new Date() },
      });
    } else {
      const email = parsed.target.toLowerCase();
      await prisma.clientPrefs.upsert({
        where: { entityId_email: { entityId: parsed.entityId, email } },
        create: { entityId: parsed.entityId, email, emailOptOut: true, emailOptOutAt: new Date() },
        update: { emailOptOut: true, emailOptOutAt: new Date() },
      });
    }

    res.send(page("Désabonnement confirmé", "Vous ne recevrez plus nos newsletters et campagnes email. Les échanges liés à votre compte ou à un séjour en cours continuent de vous parvenir normalement."));
  })
);
