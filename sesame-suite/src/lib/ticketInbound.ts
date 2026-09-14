import { CrmTicket } from "@prisma/client";
import { prisma } from "../db";
import { fireTrigger } from "./automation";
import { recordScoreEvent } from "./crmScoring";

/**
 * Logique de création/complétion de ticket à partir d'un email entrant —
 * point de convergence partagé par POST /wa/ticket/create + /publicReply
 * (widget/lien public, saisie manuelle) et routes/graphMail.ts (import
 * automatique depuis la boîte support via Microsoft Graph), pour ne pas
 * dupliquer la logique "trouver/créer le prospect", "rouvrir un ticket
 * fermé" et le déclenchement des règles d'automatisation.
 */

/**
 * Tag `[TKT-2026-0001]` inséré dans le sujet de chaque réponse d'agent (cf.
 * POST /wa/crmTicket/reply) — le numéro de ticket lui-même (CrmTicket.number),
 * plus lisible que l'ancien suffixe d'id opaque. Le retrouver dans le sujet
 * d'un email entrant permet de rattacher une réponse à son ticket plutôt que
 * d'en créer un nouveau à chaque échange.
 */
export function extractTicketTag(subject: string): string | null {
  const m = /\[(TKT-\d{4}-\d+)\]/i.exec(subject || "");
  return m ? m[1].toUpperCase() : null;
}

export async function findTicketByTag(tag: string) {
  return prisma.crmTicket.findFirst({ where: { number: tag } });
}

/**
 * Numéro de ticket lisible (ex : TKT-2026-0001), même convention que
 * nextQuoteNumber() dans crmQuote.ts — compté par année plutôt qu'un
 * compteur global, pour ne jamais dépendre d'une séquence SQL dédiée.
 */
async function nextTicketNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `TKT-${year}-`;
  const count = await prisma.crmTicket.count({ where: { number: { startsWith: prefix } } });
  for (let i = count + 1; i < count + 50; i++) {
    const candidate = `${prefix}${String(i).padStart(4, "0")}`;
    const exists = await prisma.crmTicket.findUnique({ where: { number: candidate } });
    if (!exists) return candidate;
  }
  // Filet de sécurité improbable (>50 collisions) — timestamp garantit l'unicité.
  return `${prefix}${Date.now()}`;
}

/**
 * Indicateur "nombre de mails entrants" sur la fiche prospect
 * (CrmProspect.inboundReplyCount/lastInboundReplyAt, déjà affiché en badge
 * ✉ N sur la fiche) + point de score correspondant (cf. lib/crmScoring.ts,
 * config.pointsInboundEmail) — appelé à chaque email entrant traité ici,
 * qu'il ouvre un ticket ou complète un ticket existant (import automatique
 * Microsoft Graph ou lien public de suivi de ticket, mêmes deux appelants
 * que createTicketFromInboundEmail/appendInboundReply).
 */
async function recordInboundEmail(prospectId: string, receivedAt: Date) {
  await prisma.crmProspect.update({
    where: { id: prospectId },
    data: { inboundReplyCount: { increment: 1 }, lastInboundReplyAt: receivedAt },
  });
  await recordScoreEvent(prospectId, "inbound_email", null, "internal").catch((e) =>
    console.error("[crmScoring] échec inbound_email:", e)
  );
}

export async function findOrCreateProspectByEmail(email: string, name?: string) {
  let prospect = await prisma.crmProspect.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
  if (!prospect) {
    prospect = await prisma.crmProspect.create({
      data: { nom: name || email, email, type: "Client", danger: "Modéré", contrat: "non" },
    });
    fireTrigger("crm.prospect_created", {
      entityId: null,
      targetType: "crmProspect",
      targetId: prospect.id,
      recipient: { email: prospect.email, phone: prospect.tel },
      variables: { nom: prospect.nom, secteur: prospect.secteur || "" },
    }).catch((e) => console.error("[automation] crm.prospect_created:", e));
  }
  return prospect;
}

export async function createTicketFromInboundEmail(input: {
  email: string;
  name?: string;
  subject: string;
  body: string;
  attachments?: string[];
  graphMessageId?: string;
}): Promise<CrmTicket> {
  const prospect = await findOrCreateProspectByEmail(input.email, input.name);
  const number = await nextTicketNumber();

  const ticket = await prisma.crmTicket.create({
    data: {
      number,
      prospectId: prospect.id,
      subject: input.subject || "(sans objet)",
      contactEmail: input.email,
      contactName: input.name || null,
      messages: {
        create: {
          authorType: "client",
          authorName: input.name || input.email,
          kind: "reply",
          body: input.body,
          attachments: input.attachments || [],
          graphMessageId: input.graphMessageId,
        },
      },
    },
  });

  fireTrigger("crm.ticket_created", {
    entityId: null,
    targetType: "crmTicket",
    targetId: ticket.id,
    recipient: { email: null, phone: null },
    variables: { nom: prospect.nom, secteur: prospect.secteur || "" },
  }).catch((e) => console.error("[automation] crm.ticket_created:", e));

  await recordInboundEmail(prospect.id, ticket.createdAt);

  return ticket;
}

/**
 * Complète un ticket existant avec une réponse client — rouvre
 * automatiquement un ticket fermé (un client qui revient sur un incident
 * qu'on croyait résolu, c'est le signal même qu'il ne l'est pas ; même
 * règle que POST /wa/ticket/publicReply).
 */
export async function appendInboundReply(
  ticket: CrmTicket,
  input: { authorName?: string; body: string; attachments?: string[]; graphMessageId?: string }
) {
  await prisma.crmTicketMessage.create({
    data: {
      ticketId: ticket.id,
      authorType: "client",
      authorName: input.authorName || ticket.contactName || ticket.contactEmail,
      kind: "reply",
      body: input.body,
      attachments: input.attachments || [],
      graphMessageId: input.graphMessageId,
    },
  });

  const data: Record<string, unknown> = { updatedAt: new Date() };
  if (ticket.status === "Fermé") {
    data.status = "En attente";
    data.closedAt = null;
  } else if (ticket.status !== "En attente") {
    data.status = "En attente";
  }
  await prisma.crmTicket.update({ where: { id: ticket.id }, data });

  fireTrigger("crm.ticket_client_replied", {
    entityId: null,
    targetType: "crmTicket",
    targetId: ticket.id + ":" + Date.now(), // pas de dédup — chaque relance client doit notifier
    recipient: { email: null, phone: null },
    variables: { nom: ticket.contactName || ticket.contactEmail, secteur: "" },
  }).catch((e) => console.error("[automation] crm.ticket_client_replied:", e));

  await recordInboundEmail(ticket.prospectId, new Date());
}
