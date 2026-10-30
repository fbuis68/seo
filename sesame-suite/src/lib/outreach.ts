import crypto from "node:crypto";
import { prisma } from "../db";
import { config } from "../config";
import { generateOutreachEmail, classifyOutreachReply } from "./aiClaude";
import { sendGraphMail } from "./graph";

/**
 * Sesame AI Autonomous Prospecting — P2 "Prospection commerciale
 * supervisée" (30/10/2026). Toute écriture CRM et tout envoi vivent ICI,
 * jamais dans aiClaude.ts (séparation moteur IA / moteur d'exécution,
 * §2 du brief) — la validation humaine (approve avant send) est appliquée
 * au niveau des routes (routes/outreach.ts), jamais contournable depuis ce
 * module : createOutreachDraft() ne crée jamais un email déjà "sent".
 */

export const MARCHE_ARGUMENTS: Record<string, string> = {
  Hôtellerie: "Sesame propose un accueil autonome 24/7 (badge, QR, code, application) pour les hôtels indépendants — particulièrement utile lors d'une ouverture ou d'une rénovation, pour s'affranchir de la contrainte de réception physique continue tout en gardant une expérience client fluide.",
  Padel: "Sesame équipe les clubs de padel d'un accès autonome aux terrains en dehors des horaires de présence humaine (badge/QR/code), permettant une amplitude d'ouverture élargie sans personnel supplémentaire.",
  Résidence: "Sesame simplifie la gestion multisite des résidences étudiantes, coliving ou résidences services : accès autonome pour les résidents, pilotage centralisé pour un gestionnaire qui gère plusieurs sites.",
};
const DEFAULT_ARGUMENT = "Sesame Technology propose des solutions de contrôle d'accès connecté (badge, QR, code, application) adaptées à l'hôtellerie et aux secteurs à accueil autonome.";

export function marketArgumentFor(secteur: string | null): string {
  return (secteur && MARCHE_ARGUMENTS[secteur]) || DEFAULT_ARGUMENT;
}

async function isSuppressed(email: string | null, siren: string | null, companyName: string | null): Promise<boolean> {
  const or: Record<string, unknown>[] = [];
  if (email) or.push({ email: { equals: email, mode: "insensitive" } });
  if (siren) or.push({ siren });
  if (companyName) or.push({ companyName: { contains: companyName.slice(0, 40), mode: "insensitive" } });
  if (!or.length) return false;
  const hit = await prisma.suppression.findFirst({ where: { OR: or } });
  return !!hit;
}

/**
 * P2-01/02/06 — génère un brouillon (jamais envoyé directement, status
 * pending_approval) pour un prospect, au step donné. step=0 : premier
 * email, lié au signal le plus récent. step 1-3 : relance, référence
 * l'email précédemment ENVOYÉ au même step-1 (jamais de relance sans
 * premier email réellement parti).
 */
export async function createOutreachDraft(prospectId: string, sequenceStep: number): Promise<{ draft: Awaited<ReturnType<typeof prisma.outreachDraft.create>> | null; skippedReason: string | null }> {
  const prospect = await prisma.crmProspect.findUnique({
    where: { id: prospectId },
    select: { id: true, nom: true, secteur: true, ville: true, email: true, siren: true },
  });
  if (!prospect) return { draft: null, skippedReason: "Prospect introuvable" };

  if (await isSuppressed(prospect.email, prospect.siren, prospect.nom)) {
    return { draft: null, skippedReason: "En liste d'exclusion" };
  }

  if (sequenceStep > 0) {
    // Jamais de relance après un refus/une opposition déjà exprimée.
    const blocking = await prisma.outreachReply.findFirst({ where: { prospectId, classification: { in: ["negatif", "opposition"] } } });
    if (blocking) return { draft: null, skippedReason: `Séquence arrêtée (réponse ${blocking.classification})` };
  }

  const [signal, contact, previousDraft] = await Promise.all([
    prisma.salesSignal.findFirst({ where: { prospectId }, orderBy: [{ status: "desc" }, { publishedAt: "desc" }] }),
    prisma.crmContact.findFirst({ where: { prospectId }, orderBy: { createdAt: "desc" } }),
    sequenceStep > 0 ? prisma.outreachDraft.findFirst({ where: { prospectId, sequenceStep: sequenceStep - 1, status: "sent" } }) : Promise.resolve(null),
  ]);
  if (sequenceStep > 0 && !previousDraft) return { draft: null, skippedReason: "Aucun email précédent réellement envoyé à ce step" };

  const email = await generateOutreachEmail({
    prospectName: prospect.nom,
    marketArgument: marketArgumentFor(prospect.secteur),
    ville: prospect.ville || undefined,
    decisionMakerName: contact?.name,
    decisionMakerTitle: contact?.fonction || undefined,
    signalSummary: signal?.hypothesis || undefined,
    sequenceStep,
    previousSubject: previousDraft?.subject,
  });
  if (!email.subject || !email.bodyHtml) return { draft: null, skippedReason: "Génération IA vide" };

  const draft = await prisma.outreachDraft.create({
    data: {
      prospectId,
      contactId: contact?.id || null,
      signalId: signal?.id || null,
      sequenceStep,
      subject: email.subject,
      bodyHtml: email.bodyHtml,
      status: "pending_approval",
      recipientEmail: contact?.email || prospect.email || null,
    },
  });
  return { draft, skippedReason: null };
}

export async function approveDraft(id: string, adminId: string, adminName: string) {
  const draft = await prisma.outreachDraft.findUnique({ where: { id } });
  if (!draft) throw new Error("Brouillon introuvable");
  return prisma.outreachDraft.update({
    where: { id },
    data: {
      status: "approved",
      approvedById: adminId,
      approvedByName: adminName,
      approvedAt: new Date(),
      idempotencyKey: draft.idempotencyKey || crypto.randomUUID(),
    },
  });
}

/**
 * P2-05 + sécurité d'envoi (brief §5) — vérification opposition JUSTE
 * avant l'envoi (pas seulement à la génération, un désabonnement a pu
 * arriver entretemps), idempotence sur sentAt (un retry HTTP ne renvoie
 * jamais deux fois), jamais d'envoi hors status "approved".
 */
export async function sendDraft(id: string) {
  const draft = await prisma.outreachDraft.findUnique({ where: { id } });
  if (!draft) throw new Error("Brouillon introuvable");
  if (draft.sentAt) return draft; // déjà envoyé — idempotent, pas de double envoi
  if (draft.status !== "approved") throw new Error("Email non approuvé — validation requise avant envoi");

  const prospect = await prisma.crmProspect.findUnique({ where: { id: draft.prospectId }, select: { nom: true, email: true, siren: true } });
  if (!prospect) throw new Error("Prospect introuvable");
  if (await isSuppressed(prospect.email, prospect.siren, prospect.nom)) {
    await prisma.outreachDraft.update({ where: { id }, data: { status: "canceled" } });
    throw new Error("Envoi annulé — ce destinataire est désormais en liste d'exclusion");
  }

  const to = draft.recipientEmail || prospect.email;
  if (!to) throw new Error("Aucun destinataire connu (ni contact ni email prospect)");

  const sub = await prisma.graphMailSubscription.findFirst({ where: { purpose: "prospecting", status: "active" } });
  if (!sub?.mailbox) throw new Error("Boîte Microsoft 365 de prospection non activée (écran Prospection IA)");

  await sendGraphMail(sub.mailbox, { to, subject: draft.subject, html: draft.bodyHtml });

  const updated = await prisma.outreachDraft.update({ where: { id }, data: { status: "sent", sentAt: new Date(), recipientEmail: to } });

  await prisma.agentDecisionLog.create({
    data: {
      agentName: "outreach",
      prospectId: draft.prospectId,
      inputSummary: `Envoi email prospection (step ${draft.sequenceStep}) — ${prospect.nom}`,
      outputSummary: `Envoyé à ${to} — objet : ${draft.subject}`,
      model: config.anthropicModel,
    },
  });

  return updated;
}

export async function rejectDraft(id: string) {
  return prisma.outreachDraft.update({ where: { id }, data: { status: "rejected" } });
}

/**
 * P2-10/11 — opposition/refus : arrête la séquence immédiatement (annule
 * tout brouillon pas encore envoyé) et, pour une opposition explicite,
 * ajoute le prospect en liste d'exclusion (P0-09) — jamais une simple
 * réponse négative, qui reste un "pas maintenant" et pas un refus formel.
 */
async function cancelPendingDrafts(prospectId: string) {
  await prisma.outreachDraft.updateMany({
    where: { prospectId, status: { in: ["draft", "pending_approval", "approved"] } },
    data: { status: "canceled" },
  });
}

/**
 * P2-07/08 — associe une réponse entrante au bon prospect (contact d'abord,
 * email de fiche en repli) et la classe. Ne devine jamais : si aucun
 * prospect ne correspond, la réponse est ignorée (log console) plutôt que
 * rattachée au hasard.
 */
export async function processInboundReply(params: { fromEmail: string; subject: string; bodyText: string; graphMessageId: string; receivedAt: Date }) {
  const already = await prisma.outreachReply.findUnique({ where: { graphMessageId: params.graphMessageId } });
  if (already) return already;

  const contact = await prisma.crmContact.findFirst({ where: { email: { equals: params.fromEmail, mode: "insensitive" } } });
  const prospectId = contact?.prospectId || (await prisma.crmProspect.findFirst({ where: { email: { equals: params.fromEmail, mode: "insensitive" } }, select: { id: true } }))?.id;
  if (!prospectId) {
    console.warn(`[outreach] réponse de ${params.fromEmail} ignorée — aucun prospect/contact correspondant`);
    return null;
  }

  const result = await classifyOutreachReply(params.bodyText);
  const draft = await prisma.outreachDraft.findFirst({ where: { prospectId, status: "sent" }, orderBy: { sentAt: "desc" } });

  const reply = await prisma.outreachReply.create({
    data: {
      prospectId,
      draftId: draft?.id || null,
      fromEmail: params.fromEmail,
      subject: params.subject,
      bodyText: params.bodyText,
      classification: result.classification,
      extractedNeed: result.extractedNeed,
      graphMessageId: params.graphMessageId,
      receivedAt: params.receivedAt,
    },
  });

  if (result.classification === "opposition") {
    const prospect = await prisma.crmProspect.findUnique({ where: { id: prospectId }, select: { nom: true, siren: true } });
    await prisma.suppression.create({
      data: { email: params.fromEmail, siren: prospect?.siren || null, companyName: prospect?.nom || null, motif: "Opposition détectée en réponse email (Agent Market Hunter)", perimetre: "total" },
    });
    await cancelPendingDrafts(prospectId);
  } else if (result.classification === "negatif") {
    await cancelPendingDrafts(prospectId);
  }

  await prisma.agentDecisionLog.create({
    data: {
      agentName: "outreach",
      prospectId,
      inputSummary: `Réponse reçue de ${params.fromEmail} — "${params.subject}"`,
      outputSummary: `Classification : ${result.classification}${result.extractedNeed ? ` — besoin : ${result.extractedNeed}` : ""}`,
      model: config.anthropicModel,
    },
  });

  return reply;
}

/**
 * P2-06 — relances automatiques, appelées par lib/outreachScheduler.ts.
 * Un prospect "en pause" (dernière réponse = absence, fenêtre glissante
 * cf. caller) n'est volontairement PAS filtré ici : le scheduler décide du
 * rythme, cette fonction reste un simple générateur de brouillon par step.
 */
export async function scheduleRelances(): Promise<number> {
  const cfg = await prisma.outreachConfig.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  const delays = cfg.relanceDelaysDays.length ? cfg.relanceDelaysDays : [4, 10, 20];
  let created = 0;

  for (let step = 0; step < Math.min(delays.length, cfg.maxRelances); step++) {
    const delayMs = delays[step] * 24 * 60 * 60_000;
    const cutoff = new Date(Date.now() - delayMs);
    const eligibleSent = await prisma.outreachDraft.findMany({
      where: { sequenceStep: step, status: "sent", sentAt: { lte: cutoff } },
      select: { prospectId: true },
    });
    for (const { prospectId } of eligibleSent) {
      const [nextExists, anyReply, recentAbsence] = await Promise.all([
        prisma.outreachDraft.findFirst({ where: { prospectId, sequenceStep: step + 1 } }),
        prisma.outreachReply.findFirst({ where: { prospectId, classification: { in: ["positif", "negatif", "opposition"] } } }),
        prisma.outreachReply.findFirst({ where: { prospectId, classification: "absence", receivedAt: { gte: new Date(Date.now() - 14 * 24 * 60 * 60_000) } } }),
      ]);
      if (nextExists || anyReply || recentAbsence) continue;
      const { draft } = await createOutreachDraft(prospectId, step + 1);
      if (draft) created++;
    }
  }
  return created;
}

/** P2-01 déclenché automatiquement pour les prospects qualifiés par le Market Hunter, sans premier email existant — jamais pour les fiches CRM pré-existantes (seules celles créées par l'agent entrent dans ce flux automatique, cf. lib/outreachScheduler.ts). */
export async function scheduleFirstContacts(): Promise<number> {
  const candidates = await prisma.crmProspect.findMany({
    where: { origine: "Market Hunter IA", outreachDrafts: { none: {} } },
    select: { id: true },
    take: 30,
  });
  let created = 0;
  for (const c of candidates) {
    const { draft } = await createOutreachDraft(c.id, 0);
    if (draft) created++;
  }
  return created;
}
