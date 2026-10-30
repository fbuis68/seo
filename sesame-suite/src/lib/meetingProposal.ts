import { prisma } from "../db";
import { config } from "../config";
import { OutreachReply } from "@prisma/client";
import { matchProposedSlot, generateMeetingBrief } from "./aiClaude";
import { marketArgumentFor } from "./outreach";
import { getFreeBusy, resolveGraphUserId, createOnlineMeeting } from "./graphMeetings";
import { sendGraphMail } from "./graph";

/**
 * Sesame AI Autonomous Prospecting — P3 "Conversion en rendez-vous"
 * (30/10/2026). Règle impérative reprise du brief §6 : AUCUN rendez-vous
 * créé sans confirmation explicite d'un créneau par le prospect —
 * confirmProposal() est le seul chemin qui appelle createOnlineMeeting(),
 * jamais handlePositiveReply() seule.
 */

function parisParts(d: Date): { hour: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false, weekday: "short" });
  const parts = fmt.formatToParts(d);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value || "";
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour, weekday: map[weekdayStr] ?? -1 };
}

function isBusinessSlot(d: Date): boolean {
  const { hour, weekday } = parisParts(d);
  return weekday >= 1 && weekday <= 5 && hour >= 9 && hour < 18;
}

function overlapsBusy(start: Date, end: Date, busy: { start: Date; end: Date }[]): boolean {
  return busy.some((b) => start < b.end && end > b.start);
}

/** P3-04 — 3 créneaux libres de 60 min, heures ouvrées Europe/Paris, espacés d'au moins 3h entre eux. */
function computeFreeSlots(busy: { start: Date; end: Date }[], fromDate: Date, count: number, maxDays: number): Date[] {
  const slots: Date[] = [];
  const cursor = new Date(fromDate);
  cursor.setUTCMinutes(0, 0, 0);
  const limit = new Date(fromDate.getTime() + maxDays * 24 * 60 * 60_000);
  while (cursor.getTime() < limit.getTime() && slots.length < count) {
    const slotEnd = new Date(cursor.getTime() + 60 * 60_000);
    if (isBusinessSlot(cursor) && !overlapsBusy(cursor, slotEnd, busy)) {
      const tooClose = slots.some((s) => Math.abs(s.getTime() - cursor.getTime()) < 3 * 60 * 60_000);
      if (!tooClose) slots.push(new Date(cursor));
    }
    cursor.setTime(cursor.getTime() + 60 * 60_000);
  }
  return slots;
}

/**
 * P3-01/02/03/04/10 — sur réponse positive sans proposition déjà en cours :
 * calcule 3 créneaux réels (calendrier Outlook du commercial assigné) et
 * crée une proposition à valider (jamais envoyée automatiquement, P3-05).
 * Si une proposition est déjà "sent" pour ce prospect, cette réponse est
 * probablement la confirmation d'un créneau — déléguée à routes/outreach.ts
 * (matchProposedSlot), jamais traitée ici pour éviter une double logique.
 */
export async function handlePositiveReply(reply: OutreachReply): Promise<void> {
  if (reply.processedForMeeting) return;
  await prisma.outreachReply.update({ where: { id: reply.id }, data: { processedForMeeting: true } });

  const pending = await prisma.meetingProposal.findFirst({ where: { prospectId: reply.prospectId, status: "sent", confirmedSlot: null } });
  if (pending) return; // confirmation potentielle — traitée par matchAndConfirm (routes/outreach.ts), pas une nouvelle proposition

  const prospect = await prisma.crmProspect.findUnique({ where: { id: reply.prospectId }, select: { nom: true, secteur: true, email: true, commercialId: true } });
  if (!prospect?.commercialId) {
    console.warn(`[meetingProposal] prospect ${reply.prospectId} intéressé mais aucun commercial assigné — proposition non générée`);
    return;
  }
  const commercial = await prisma.adminUser.findUnique({ where: { id: prospect.commercialId }, select: { id: true, email: true, name: true } });
  if (!commercial?.email) return;

  let slots: Date[] = [];
  try {
    const from = new Date(Date.now() + 24 * 60 * 60_000);
    const busy = await getFreeBusy(commercial.email, from.toISOString(), new Date(from.getTime() + 15 * 24 * 60 * 60_000).toISOString());
    slots = computeFreeSlots(busy, from, 3, 15);
  } catch (e) {
    console.error(`[meetingProposal] lecture disponibilités échouée (${commercial.email}):`, e);
    return;
  }
  if (slots.length < 3) {
    console.warn(`[meetingProposal] moins de 3 créneaux libres trouvés pour ${commercial.email} — proposition non générée`);
    return;
  }

  const briefText = await generateMeetingBrief({
    prospectName: prospect.nom,
    marketArgument: marketArgumentFor(prospect.secteur),
    extractedNeed: reply.extractedNeed,
  }).catch(() => null);

  const proposal = await prisma.meetingProposal.create({
    data: {
      prospectId: reply.prospectId,
      replyId: reply.id,
      commercialId: commercial.id,
      commercialEmail: commercial.email,
      slot1: slots[0],
      slot2: slots[1],
      slot3: slots[2],
      briefText,
      status: "pending_approval",
    },
  });

  await prisma.agentDecisionLog.create({
    data: {
      agentName: "meeting_proposal",
      prospectId: reply.prospectId,
      inputSummary: `Intérêt détecté — proposition de 3 créneaux (commercial : ${commercial.name || commercial.email})`,
      outputSummary: `Créneaux proposés : ${proposal.slot1.toISOString()}, ${proposal.slot2.toISOString()}, ${proposal.slot3.toISOString()}`,
      model: config.anthropicModel,
    },
  });
}

export async function approveProposal(id: string, adminId: string) {
  return prisma.meetingProposal.update({ where: { id }, data: { status: "approved", approvedById: adminId, approvedAt: new Date() } });
}

function fmtParis(d: Date): string {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(d);
}

/** P3-05 — envoie la proposition des 3 créneaux au prospect (jamais sans approbation). */
export async function sendProposal(id: string) {
  const proposal = await prisma.meetingProposal.findUnique({ where: { id } });
  if (!proposal) throw new Error("Proposition introuvable");
  if (proposal.sentAt) return proposal;
  if (proposal.status !== "approved") throw new Error("Proposition non approuvée — validation requise avant envoi");

  const prospect = await prisma.crmProspect.findUnique({ where: { id: proposal.prospectId }, select: { nom: true, email: true } });
  const contact = await prisma.crmContact.findFirst({ where: { prospectId: proposal.prospectId }, orderBy: { createdAt: "desc" } });
  const to = contact?.email || prospect?.email;
  if (!to) throw new Error("Aucun destinataire connu");

  const sub = await prisma.graphMailSubscription.findFirst({ where: { purpose: "prospecting", status: "active" } });
  if (!sub?.mailbox) throw new Error("Boîte Microsoft 365 de prospection non activée");

  const html = `<p>Bonjour,</p><p>Voici trois créneaux possibles pour échanger avec notre équipe :</p><ul><li>${fmtParis(proposal.slot1)}</li><li>${fmtParis(proposal.slot2)}</li><li>${fmtParis(proposal.slot3)}</li></ul><p>Il vous suffit de répondre à cet email en indiquant celui qui vous convient.</p><p>Cordialement,<br>L'équipe Sesame Technology</p>`;
  await sendGraphMail(sub.mailbox, { to, subject: `Proposition de rendez-vous — ${prospect?.nom || ""}`, html });

  return prisma.meetingProposal.update({ where: { id }, data: { status: "sent", sentAt: new Date() } });
}

/**
 * P3-06/07/08/09 — confirme un créneau et crée RÉELLEMENT la réunion Teams
 * (jamais avant cet appel). Idempotent sur meetingId : un deuxième appel
 * (retry, double notification Graph) ne recrée jamais la réunion.
 */
export async function confirmProposal(id: string, slotIndex: 1 | 2 | 3) {
  const proposal = await prisma.meetingProposal.findUnique({ where: { id } });
  if (!proposal) throw new Error("Proposition introuvable");
  if (proposal.meetingId) return proposal; // déjà confirmée — pas de double réservation

  const slot = slotIndex === 1 ? proposal.slot1 : slotIndex === 2 ? proposal.slot2 : proposal.slot3;
  const prospect = await prisma.crmProspect.findUnique({ where: { id: proposal.prospectId }, select: { nom: true, email: true } });
  const contact = await prisma.crmContact.findFirst({ where: { prospectId: proposal.prospectId }, orderBy: { createdAt: "desc" } });
  const commercial = proposal.commercialId ? await prisma.adminUser.findUnique({ where: { id: proposal.commercialId } }) : null;
  if (!commercial?.email) throw new Error("Commercial introuvable — impossible de créer la réunion");

  const organizerUserId = await resolveGraphUserId(commercial.email);
  const endDateTime = new Date(slot.getTime() + 60 * 60_000);
  const meeting = await createOnlineMeeting({
    organizerUserId,
    subject: `Rendez-vous Sesame Technology — ${prospect?.nom || ""}`,
    startDateTime: slot,
    endDateTime,
    attendeeEmail: contact?.email || prospect?.email || undefined,
    attendeeName: contact?.name || prospect?.nom,
  });

  const crmMeeting = await prisma.crmMeeting.create({
    data: {
      prospectId: proposal.prospectId,
      subject: `Rendez-vous Sesame Technology — ${prospect?.nom || ""}`,
      organizerEmail: commercial.email,
      startDateTime: slot,
      endDateTime,
      joinUrl: meeting.joinWebUrl,
      graphMeetingId: meeting.id,
      graphOrganizerUserId: organizerUserId,
      status: "scheduled",
    },
  });

  const updated = await prisma.meetingProposal.update({ where: { id }, data: { status: "confirmed", confirmedSlot: slot, meetingId: crmMeeting.id } });

  await prisma.agentDecisionLog.create({
    data: {
      agentName: "meeting_proposal",
      prospectId: proposal.prospectId,
      inputSummary: `Confirmation du créneau ${slotIndex} par le prospect`,
      outputSummary: `Réunion Teams créée — ${slot.toISOString()}`,
      model: config.anthropicModel,
    },
  });

  return updated;
}

/** Appelé par le handler d'email entrant (routes/graphMail.ts) quand une proposition "sent" attend une confirmation — jamais de confirmation auto sur réponse ambiguë (slotIndex=0). */
export async function matchAndConfirm(prospectId: string, bodyText: string): Promise<boolean> {
  const proposal = await prisma.meetingProposal.findFirst({ where: { prospectId, status: "sent", confirmedSlot: null } });
  if (!proposal) return false;
  const idx = await matchProposedSlot(bodyText, [proposal.slot1.toISOString(), proposal.slot2.toISOString(), proposal.slot3.toISOString()]);
  if (idx === 0) return false;
  await confirmProposal(proposal.id, idx as 1 | 2 | 3);
  return true;
}
