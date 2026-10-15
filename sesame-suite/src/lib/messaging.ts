import QRCode from "qrcode";
import { prisma } from "../db";
import { HttpError } from "./asyncHandler";
import { sendEmailRaw } from "./email";
import { sendChannelRaw, sendWhatsAppTemplate, sendRcsTemplate } from "./sms";
import { Channel } from "./messageTemplate";
import { config } from "../config";
import { attachQuestionnaireLink } from "./questionnaire";
import { createUnsubscribeToken } from "./unsubscribeToken";
// fetchAccessQr vient de ./bookingSource, qui importe lui-même ./automation,
// qui importe sendMessage() d'ICI — cycle d'imports existant (bookingSource
// → automation → messaging), fermé ici en sens inverse. Sans risque tant
// que fetchAccessQr n'est référencé qu'À L'INTÉRIEUR du corps de
// sendMessage() (jamais au niveau module), donc seulement une fois tous les
// modules chargés — jamais au chargement initial de ce fichier.
import { fetchAccessQr } from "./bookingSource";

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
  /**
   * Email uniquement — pièces jointes propres à CET envoi, en plus des
   * pièces jointes fixes du modèle (MessageTemplate.defaultAttachments) —
   * ex : la facture PDF concernée sur une relance de paiement
   * (routes/accounting.ts), différente à chaque appel donc jamais
   * modélisable comme pièce jointe fixe du modèle lui-même.
   */
  extraAttachments?: { fileName: string; dataUrl: string }[];
  /**
   * RCS uniquement — bascule SMS si le RCS n'est pas accepté sur l'appareil
   * du destinataire (champ `failover` de l'API SMSPartner). Optionnel :
   * sans lui, un destinataire sans RCS ne reçoit simplement rien.
   */
  rcsFailover?: { sender: string; message: string };
}) {
  const template = await prisma.messageTemplate.findFirst({
    where: { entityId: opts.entityId, channel: opts.channel, key: opts.templateKey },
    include: { senderIdentity: true },
  });
  if (!template) throw new HttpError(404, "Modèle introuvable pour ce canal");

  let vars = opts.variables || {};
  // Questionnaire réglé sur le modèle (MessageTemplate.questionnaireId) —
  // couvre aussi bien un envoi manuel (bouton "Envoyer un message" depuis
  // une fiche prospect, qui n'a pas de règle d'automatisation à interroger)
  // qu'un envoi automatique dont la règle n'a pas elle-même de questionnaire
  // réglé. N'écrase jamais {{lienQuestionnaire}} si déjà fourni par
  // l'appelant (cf. fireTrigger, qui l'attache lui-même depuis
  // AutomationRule.questionnaireId AVANT d'appeler sendMessage).
  if (template.questionnaireId && opts.entityId === null && opts.trackOpenProspectId && !vars.lienQuestionnaire) {
    vars = await attachQuestionnaireLink(template.questionnaireId, "crmProspect", opts.trackOpenProspectId, vars);
  }
  // {{lienDesabonnement}} — rendu disponible pour TOUT modèle email en
  // portée CRM, pas uniquement les campagnes (qui ajoutent déjà leur propre
  // pied de page fixe via campaignScheduler.ts, cf. unsubscribeFooterHtml) :
  // un modèle manuel (relance, newsletter ponctuelle...) peut insérer ce
  // lien lui-même en tapant la variable dans son corps. Jamais injecté de
  // force — si le modèle ne contient pas {{lienDesabonnement}}, la variable
  // calculée ici reste simplement inutilisée, renderTemplate() ne remplaçant
  // que ce qui apparaît réellement dans le texte.
  if (opts.channel === "email" && opts.entityId === null && !vars.lienDesabonnement) {
    const base = opts.baseUrl || config.publicBaseUrl;
    const token = createUnsubscribeToken({ entityId: null, target: opts.to });
    vars = { ...vars, lienDesabonnement: `${base}/wa/unsubscribe?token=${encodeURIComponent(token)}` };
  }
  // {{codeAcces}} — code d'accès RÉEL généré par la serrure/PMS pour cette
  // réservation, PAS le code de réservation ({{code}}) : demande client
  // 15/10/2026, après avoir confirmé que {{code}} renvoie Booking.code
  // (numéro de réservation) et pas le code d'ouverture de porte. Récupéré
  // à la demande via la même intégration que le bouton "Générer une clé"
  // (fetchAccessQr, cf. routes/booking.ts, qrEndpointPath de
  // BookingSourceConfig) — seulement en portée hôtel (opts.entityId non
  // null, jamais en CRM) et seulement si le modèle référence effectivement
  // {{codeAcces}} ou {{qrCode}} (qui en dépend, cf. plus bas) : un appel
  // réseau vers la source externe à chaque envoi serait coûteux et fragile
  // pour les modèles qui n'en ont pas besoin. Échec ou intégration non
  // configurée → simplement journalisé, {{codeAcces}} reste vide comme
  // toute variable non fournie par le déclencheur, le reste de l'envoi
  // n'est jamais bloqué pour autant.
  const wantsAccessCode =
    template.bodyHtml.includes("{{codeAcces}}") ||
    template.subject.includes("{{codeAcces}}") ||
    template.bodyHtml.includes("{{qrCode}}") ||
    template.subject.includes("{{qrCode}}");
  if (opts.channel === "email" && opts.entityId && vars.code && !vars.codeAcces && wantsAccessCode) {
    try {
      const bsConfig = await prisma.bookingSourceConfig.findUnique({ where: { entityId: opts.entityId } });
      if (bsConfig?.qrEndpointPath) {
        const { accessCode } = await fetchAccessQr(bsConfig, vars.code, opts.to);
        if (accessCode) vars = { ...vars, codeAcces: accessCode };
      }
    } catch (e) {
      console.error("[messaging] Échec de récupération de {{codeAcces}} :", e);
    }
  }
  // {{qrCode}} — image QR (data URL PNG) encodant {{codeAcces}} (le vrai
  // code d'ouverture de porte) quand disponible, sinon {{code}} (code de
  // réservation, à défaut — ex : modèle commercial hors contexte
  // réservation). Même principe que {{lienDesabonnement}} ci-dessus :
  // calculée seulement si absente, jamais si l'appelant l'a déjà fournie,
  // et simplement inutilisée si le modèle ne contient pas {{qrCode}}.
  const qrSource = vars.codeAcces || vars.code;
  if (opts.channel === "email" && qrSource && !vars.qrCode) {
    vars = { ...vars, qrCode: await QRCode.toDataURL(qrSource, { margin: 1, width: 320 }) };
  }
  const subject = renderTemplate(template.subject, vars);
  let body = renderTemplate(template.bodyHtml, vars);

  // template.category === "support" exclu du score d'intérêt (30/09/2026,
  // demande client) : un échange support (ex: réponse à une question
  // technique envoyée manuellement depuis la fiche, hors flux ticket dédié
  // qui n'utilise de toute façon pas ce chemin) n'indique aucun intérêt
  // commercial — seuls les modèles marketing/commercial (ou non catégorisés)
  // posent le pixel de suivi.
  if (opts.channel === "email" && opts.entityId === null && opts.trackOpenProspectId && template.category !== "support") {
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
    const namedAttachments = (Array.isArray(template.defaultAttachments)
      ? (template.defaultAttachments as unknown as { fileName: string; dataUrl: string }[])
      : []
    ).concat(opts.extraAttachments || []);
    // Identité d'expédition réglée sur le modèle (EmailSenderIdentity,
    // 29/09/2026) — un opts.fromNameOverride explicite (ex: réponse à un
    // ticket, cf. crmTicket.ts) reste toujours prioritaire sur celle du
    // modèle, même logique de priorité que fromHeader() dans lib/email.ts.
    const fromNameOverride = opts.fromNameOverride || template.senderIdentity?.name || undefined;
    const fromEmailOverride = template.senderIdentity?.email || undefined;
    // En-tête List-Unsubscribe (cf. lib/email.ts) — recalculé ici plutôt que
    // transmis par l'appelant : même entrées (entityId, destinataire) que le
    // lien déjà inséré dans le pied de page par campaignScheduler.ts
    // (unsubscribeFooterHtml), donc même token — seulement pour un envoi de
    // campagne (appendBodyHtml, cf. sa définition ci-dessus), jamais sur un
    // email transactionnel qui n'a pas de lien de désabonnement dans le corps.
    const listUnsubscribeUrl = opts.appendBodyHtml
      ? `${opts.baseUrl || config.publicBaseUrl}/wa/unsubscribe?token=${encodeURIComponent(createUnsubscribeToken({ entityId: opts.entityId, target: opts.to }))}`
      : undefined;
    await sendEmailRaw(opts.entityId, opts.to, subject, body, fromNameOverride, { namedAttachments, fromEmailOverride, listUnsubscribeUrl });
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
  } else if (opts.channel === "rcs") {
    // RCS SMSPartner (15/10/2026) : le contenu vient exclusivement d'un
    // modèle enregistré sur leur plateforme (rcsModelToken), jamais du
    // bodyHtml du modèle Sesame — même raison que whatsappContentSid
    // ci-dessus, refus explicite plutôt que d'envoyer un RCS vide.
    if (!template.rcsModelToken) {
      throw new HttpError(
        400,
        "Ce modèle RCS n'a pas d'identifiant de modèle SMSPartner — créez le modèle correspondant sur my.smspartner.fr (Modèles de message, type RCS), puis collez son identifiant (32 caractères) dans ce modèle Sesame."
      );
    }
    await sendRcsTemplate(opts.entityId, opts.to, template.rcsModelToken, opts.rcsFailover);
  } else {
    await sendChannelRaw(opts.entityId, opts.channel, opts.to, body);
  }
  return { subject, body };
}
