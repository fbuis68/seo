import { prisma } from "../db";
import { sendMessage } from "./messaging";
import { Channel } from "./messageTemplate";
import { createUnsubscribeToken } from "./unsubscribeToken";
import { resolveCrmAudience, resolveHotelAudience, CrmAudienceFilter, HotelAudienceFilter, CampaignRecipient } from "./campaignAudience";
import { config } from "../config";

// Intervalle court (contrairement aux 15 min de l'automationScheduler) : une
// campagne programmée "à telle heure" doit partir à quelques minutes près,
// pas dans la demi-heure qui suit. Le balayage lui-même est bon marché (une
// requête sur Campaign.status='scheduled') tant qu'aucun envoi n'est dû.
const CHECK_INTERVAL_MS = 60_000;
let running = false;

// Espacement entre emails (05/10/2026, puis durci le 12/10/2026) — une
// boîte Exchange normale qui envoie un gros volume d'affilée, même en
// pauses par PAQUET de 20 (ancienne version), reste détectée par M365
// comme un pattern de compte compromis/spam : l'alerte "Suspicious outbound
// email activity" a continué à se déclencher malgré cette première pause,
// signe que c'est le DÉBIT en RAFALE (plusieurs dizaines de mails d'un coup
// avant chaque pause) qui est repéré, pas seulement le volume total. Pause
// FIXE après CHAQUE email plutôt qu'après chaque paquet : lisse le débit à
// 20 mails/minute environ, nettement sous le seuil usuel de 30/minute
// documenté par Microsoft pour une boîte standard, sans rafale au début de
// chaque lot. Combiné à l'en-tête List-Unsubscribe (cf. lib/email.ts) —
// toujours insuffisant, c'est que la boîte M365 standard n'est de toute
// façon pas conçue pour l'envoi de masse ; au-delà de quelques centaines de
// destinataires, passer par un vrai service transactionnel (SendGrid,
// Mailgun, Brevo...) authentifié SPF/DKIM/DMARC pour ce domaine.
const CAMPAIGN_EMAIL_DELAY_MS = 3_000;
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startCampaignScheduler() {
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runCampaignSweep();
    } catch (e) {
      console.error("[campaignScheduler] balayage échoué:", e);
    } finally {
      running = false;
    }
  }, CHECK_INTERVAL_MS);
  console.log("[campaignScheduler] démarré (vérification toutes les 60s)");
}

function unsubscribeFooterHtml(entityId: string | null, target: string): string {
  const token = createUnsubscribeToken({ entityId, target });
  const base = config.publicBaseUrl;
  const url = `${base}/wa/unsubscribe?token=${encodeURIComponent(token)}`;
  return `<p style="margin-top:24px;font-size:11px;color:#8a8a8a;font-family:Arial,sans-serif;text-align:center">Vous recevez cet email car vous êtes en contact avec Sesame Technology.<br><a href="${url}" style="color:#8a8a8a">Se désabonner de cette newsletter</a></p>`;
}

/**
 * Traite UNE campagne due — extrait pour être appelable directement par
 * routes/campaign.ts juste après la création d'un envoi "immédiat" (pas de
 * scheduledAt fourni), sans attendre le prochain tick du setInterval.
 */
export async function processDueCampaign(campaignId: string): Promise<void> {
  // Verrou optimiste : seule l'instance qui gagne cette updateMany traite la
  // campagne, évite un double envoi si le tick périodique et un appel
  // "envoyer maintenant" se chevauchent sur le même id.
  const claimed = await prisma.campaign.updateMany({
    where: { id: campaignId, status: "scheduled" },
    data: { status: "sending" },
  });
  if (claimed.count === 0) return;

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return;

  try {
    const manualIds = (campaign.manualSelectionIds as string[] | null) || null;
    const rawRecipients: CampaignRecipient[] = campaign.entityId
      ? await resolveHotelAudience(campaign.entityId, (campaign.filterJson as HotelAudienceFilter | null) || null, manualIds)
      : await resolveCrmAudience((campaign.filterJson as CrmAudienceFilter | null) || null, manualIds);

    // Un même email peut apparaître deux fois dans l'audience résolue (ex :
    // deux fiches CrmProspect distinctes partageant le même email) — on ne
    // veut jamais envoyer le même mail deux fois au même destinataire.
    const seenEmails = new Set<string>();
    const recipients = rawRecipients.filter((r) => {
      const key = r.toEmail.trim().toLowerCase();
      if (seenEmails.has(key)) return false;
      seenEmails.add(key);
      return true;
    });

    let success = 0;
    let failure = 0;
    let lastError = "";
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      try {
        const appendBodyHtml = campaign.channel === "email" ? unsubscribeFooterHtml(campaign.entityId, r.toEmail) : undefined;
        await sendMessage({
          entityId: campaign.entityId,
          channel: campaign.channel as Channel,
          templateKey: campaign.templateKey || "",
          to: r.toEmail,
          variables: r.variables,
          appendBodyHtml,
        });
        success += 1;
      } catch (e) {
        failure += 1;
        lastError = e instanceof Error ? e.message : "Erreur d'envoi";
      }
      // Pause après CHAQUE email — jamais après le dernier destinataire
      // (inutile, la campagne est terminée).
      if (campaign.channel === "email" && i + 1 < recipients.length) {
        await sleep(CAMPAIGN_EMAIL_DELAY_MS);
      }
    }

    await prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status: "sent",
        sentAt: new Date(),
        audienceSize: recipients.length,
        successCount: success,
        failureCount: failure,
        lastError: failure > 0 ? lastError : null,
      },
    });
  } catch (e) {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "failed", lastError: e instanceof Error ? e.message : "Erreur inattendue" },
    });
  }
}

export async function runCampaignSweep(): Promise<void> {
  const due = await prisma.campaign.findMany({
    where: { status: "scheduled", scheduledAt: { lte: new Date() } },
    select: { id: true },
  });
  for (const c of due) {
    await processDueCampaign(c.id);
  }
}
