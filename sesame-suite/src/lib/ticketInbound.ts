import { CrmTicket } from "@prisma/client";
import { prisma } from "../db";
import { fireTrigger } from "./automation";

/**
 * Logique de création/complétion de ticket à partir d'un email entrant —
 * point de convergence partagé par POST /wa/ticket/create + /publicReply
 * (widget/lien public, saisie manuelle) et routes/graphMail.ts (import
 * automatique depuis la boîte support via Microsoft Graph), pour ne pas
 * dupliquer la logique "trouver/créer le prospect", "rouvrir un ticket
 * fermé" et le déclenchement des règles d'automatisation.
 */

/**
 * Tag `[#xxxxxx]` inséré dans le sujet de chaque réponse d'agent (cf.
 * POST /wa/crmTicket/reply) — les 6 derniers caractères de l'id du ticket.
 * Le retrouver dans le sujet d'un email entrant permet de rattacher une
 * réponse à son ticket plutôt que d'en créer un nouveau à chaque échange.
 */
export function extractTicketTag(subject: string): string | null {
  const m = /\[#([a-z0-9]{6})\]/i.exec(subject || "");
  return m ? m[1].toLowerCase() : null;
}

export async function findTicketByTag(tag: string) {
  return prisma.crmTicket.findFirst({ where: { id: { endsWith: tag } } });
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

  const ticket = await prisma.crmTicket.create({
    data: {
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
}
