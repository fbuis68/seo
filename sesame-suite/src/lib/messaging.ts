import { prisma } from "../db";
import { HttpError } from "./asyncHandler";
import { sendEmailRaw } from "./email";
import { sendChannelRaw, sendWhatsAppTemplate } from "./sms";
import { Channel } from "./messageTemplate";
import { config } from "../config";

/**
 * Point de convergence unique : quel que soit le canal (email/sms/whatsapp),
 * l'appelant (routes/email.ts pour l'envoi manuel, automation.ts pour les
 * règles) passe par sendMessage() — c'est ici, et seulement ici, que le
 * canal est traduit vers le bon transport (SMTP ou Twilio).
 */

function renderTemplate(str: string, vars: Record<string, string>): string {
  return str.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => vars[key] ?? "");
}

/**
 * Valeurs des variables {{var}} d'un modèle, dans leur ordre d'apparition —
 * sert à construire les ContentVariables Twilio ("1","2",...) attendues par
 * un Content Template WhatsApp approuvé, dont les emplacements numérotés
 * suivent le même ordre que les {{var}} de notre bodyHtml (convention
 * documentée dans l'éditeur de modèle).
 */
function extractOrderedVariableValues(str: string, vars: Record<string, string>): string[] {
  const values: string[] = [];
  for (const m of str.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) values.push(vars[m[1]] ?? "");
  return values;
}

export async function sendMessage(opts: {
  entityId: string | null;
  channel: Channel;
  templateKey: string;
  to: string;
  variables?: Record<string, string>;
  /** Email uniquement — nom d'expéditeur affiché, remplace celui de la config SMTP pour cet envoi. */
  fromNameOverride?: string;
  /**
   * Email + portée CRM uniquement — id du CrmProspect destinataire. Quand
   * renseigné, un pixel de suivi d'ouverture (1×1, cf.
   * GET /wa/crmScoring/trackOpen) est ajouté en fin de corps ; son
   * chargement enregistre +1 point de score ("email_opened", cf.
   * lib/crmScoring.ts). Sans effet pour les hôtels — le score d'intérêt est
   * une notion CRM Sesame, pas un outil hôtelier.
   */
  trackOpenProspectId?: string;
  /**
   * Base absolue (ex: "https://crm.sesame.technology") pour le pixel de
   * suivi — cf. questionnaireLinkUrl() dans lib/questionnaire.ts, même
   * logique : sans ceci, on retombe sur config.publicBaseUrl qui vaut ""
   * tant que PUBLIC_BASE_URL n'est pas défini en env, et le pixel devient
   * une URL relative (<img src="/wa/...">) — invalide dans un email, donc
   * jamais chargée, donc aucun score jamais enregistré à l'ouverture.
   */
  baseUrl?: string;
  /**
   * Email uniquement — HTML ajouté en fin de corps après le pixel de suivi
   * éventuel (ex : pied de page de désabonnement injecté par
   * lib/campaignScheduler.ts sur un envoi de campagne). Absent pour un envoi
   * transactionnel normal (confirmation de réservation, etc.) — cette
   * fonction reste le point de convergence unique, donc ce paramètre est ce
   * qui distingue un envoi de masse d'un envoi individuel plutôt que d'en
   * faire deux chemins de code séparés.
   */
  appendBodyHtml?: string;
}) {
  const template = await prisma.messageTemplate.findFirst({
    where: { entityId: opts.entityId, channel: opts.channel, key: opts.templateKey },
  });
  if (!template) throw new HttpError(404, "Modèle introuvable pour ce canal");

  const vars = opts.variables || {};
  const subject = renderTemplate(template.subject, vars);
  let body = renderTemplate(template.bodyHtml, vars);

  if (opts.channel === "email" && opts.entityId === null && opts.trackOpenProspectId) {
    const base = opts.baseUrl || config.publicBaseUrl;
    const pixelUrl = `${base}/wa/crmScoring/trackOpen?pid=${encodeURIComponent(opts.trackOpenProspectId)}`;
    // Pas de style="display:none" : un pixel 1×1 est déjà invisible, et ce
    // marqueur est justement la signature que certaines passerelles de
    // sécurité (Proofpoint, Mimecast...) utilisent pour détecter et retirer
    // les pixels de suivi avant remise du mail.
    body += `<img src="${pixelUrl}" width="1" height="1" alt="">`;
  }
  if (opts.channel === "email" && opts.appendBodyHtml) {
    body += opts.appendBodyHtml;
  }

  if (opts.channel === "email") {
    await sendEmailRaw(opts.entityId, opts.to, subject, body, opts.fromNameOverride);
  } else if (opts.channel === "whatsapp") {
    // WhatsApp Business interdit le texte libre business-initié en dehors
    // d'une fenêtre de session client de 24h (règle Meta, pas une limite
    // Twilio) : ce modèle doit obligatoirement avoir un Content Template
    // approuvé lié (whatsappContentSid), sans quoi l'envoi échouerait
    // silencieusement côté WhatsApp — on refuse donc explicitement plutôt
    // que de retomber sur l'ancien envoi en texte libre.
    if (!template.whatsappContentSid) {
      throw new HttpError(
        400,
        "Ce modèle WhatsApp n'a pas de Content SID Twilio — créez le modèle correspondant dans Twilio (Content Template Builder), faites-le approuver par Meta, puis collez son Content SID dans ce modèle Sesame."
      );
    }
    const contentVariables = Object.fromEntries(
      extractOrderedVariableValues(template.bodyHtml, vars).map((v, i) => [String(i + 1), v])
    );
    await sendWhatsAppTemplate(opts.entityId, opts.to, template.whatsappContentSid, contentVariables);
  } else {
    await sendChannelRaw(opts.entityId, opts.channel, opts.to, body);
  }
  return { subject, body };
}
