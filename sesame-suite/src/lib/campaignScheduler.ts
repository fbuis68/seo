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
    const recipients: CampaignRecipient[] = campaign.entityId
      ? await resolveHotelAudience(campaign.entityId, (campaign.filterJson as HotelAudienceFilter | null) || null, manualIds)
      : await resolveCrmAudience((campaign.filterJson as CrmAudienceFilter | null) || null, manualIds);

    let success = 0;
    let failure = 0;
    let lastError = "";
    for (const r of recipients) {
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
