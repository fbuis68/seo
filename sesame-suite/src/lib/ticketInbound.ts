import { CrmTicket } from "@prisma/client";
import { prisma } from "../db";
import { fireTrigger } from "./automation";
import { nextSequenceValue } from "./sequence";

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
 * Ne garde que les data URI image/PDF — convention établie de
 * CrmTicketMessage.attachments (aucune autre forme n'est légitime : ni un
 * https:// externe, ni du texte libre). Sans ce filtre, un attachement
 * accepté tel quel (POST /wa/ticket/create + /publicReply sont PUBLICS,
 * sans authentification) était injecté sans échappement dans
 * `<a href="${a}"><img src="${a}">` côté crm.html, permettant une sortie
 * d'attribut — cf. audit sécurité du 15/09/2026. Filtre silencieusement les
 * entrées invalides plutôt que de faire échouer tout l'envoi.
 *
 * PDF ajouté le 22/09/2026 : le formulaire client (support.html) accepte
 * déjà `image/*,.pdf` en sélection de fichier, mais ce filtre ne laissait
 * passer QUE les images — toute pièce jointe PDF envoyée par un client
 * était donc silencieusement perdue avant même d'atteindre la base
 * (jamais un problème de rendu, cf. crm.html/support.html qui l'auraient
 * de toute façon mal affichée en <img>, corrigé dans le même correctif).
 * Reste une simple data URI base64 stricte, pas du texte libre — la
 * protection XSS n'est pas affaiblie par cet ajout.
 */
export function sanitizeTicketAttachments(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const DATA_URI_ATTACHMENT = /^data:(image\/(png|jpe?g|gif|webp)|application\/pdf);base64,[A-Za-z0-9+/]+=*$/;
  return raw.filter((a): a is string => typeof a === "string" && DATA_URI_ATTACHMENT.test(a));
}

/**
 * Retire les préfixes de réponse/transfert ("Re:", "Fwd:", "TR:"..., répétés
 * et mélangés — un client peut répondre à une réponse à une réponse) et le
 * tag `[TKT-...]` s'il en reste un, pour ne comparer que le sujet "de fond".
 */
function normalizeSubject(subject: string): string {
  return (subject || "")
    .replace(/\[(TKT-\d{4}-\d+)\]/gi, "")
    .replace(/^\s*(re|fwd?|tr|rép(?:onse)?|transf(?:ert)?)\s*:\s*/i, "")
    .trim()
    .toLowerCase();
}

/**
 * Filet de sécurité quand aucun tag `[TKT-...]` n'a matché (le client a
 * démarré un nouvel email au lieu de répondre au fil existant, ou son
 * client mail a perdu le tag) : un email de la même personne, sur le même
 * sujet "de fond", récent, est très probablement la continuation d'un
 * échange déjà ouvert plutôt qu'une nouvelle demande — cf. discussion du
 * 15/09/2026 ("considérer un seul ticket si le fil est le même, notamment
 * la description [le sujet] de l'email"). Fenêtre de 30 jours pour éviter
 * de rattacher à tort un sujet générique ("Question") réutilisé des mois
 * plus tard pour une demande sans rapport ; le plus récent des tickets
 * correspondants est pris si plusieurs matchent.
 */
async function findTicketByEmailAndSubject(email: string, subject: string) {
  const normalized = normalizeSubject(subject);
  if (!normalized) return null;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  const candidates = await prisma.crmTicket.findMany({
    where: { contactEmail: { equals: email, mode: "insensitive" }, updatedAt: { gte: since } },
    orderBy: { updatedAt: "desc" },
  });
  return candidates.find((t) => normalizeSubject(t.subject) === normalized) || null;
}

/**
 * Nom affiché de l'agent assigné, pour la variable {{agent}} des modèles
 * d'email déclenchés par un ticket (cf. TRIGGERS "crm.ticket_*" dans
 * lib/automation.ts) — "Non assigné" plutôt qu'une chaîne vide, plus lisible
 * dans un email envoyé au client.
 */
async function ticketAgentName(agentId: string | null): Promise<string> {
  if (!agentId) return "Non assigné";
  const agent = await prisma.adminUser.findUnique({ where: { id: agentId }, select: { name: true, email: true } });
  return agent ? agent.name || agent.email : "Non assigné";
}

/**
 * Numéro de ticket lisible (ex : TKT-2026-0001), compté par année. Repose
 * sur nextSequenceValue (cf. lib/sequence.ts) — un compteur atomique
 * Postgres — plutôt que "compter les lignes existantes puis deviner le
 * prochain numéro libre" (schéma remplacé le 16/09/2026 après un test de
 * charge : la version précédente produisait des centaines d'échecs "Unique
 * constraint failed" par lot de requêtes concurrentes sur POST
 * /wa/ticket/create, un endpoint public).
 */
export async function nextTicketNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const n = await nextSequenceValue(`ticket-${year}`);
  return `TKT-${year}-${String(n).padStart(4, "0")}`;
}

/**
 * Indicateur "nombre de mails entrants" sur la fiche prospect
 * (CrmProspect.inboundReplyCount/lastInboundReplyAt, déjà affiché en badge
 * ✉ N sur la fiche) — appelé à chaque email entrant traité ici, qu'il ouvre
 * un ticket ou complète un ticket existant (import automatique Microsoft
 * Graph ou lien public de suivi de ticket, mêmes deux appelants que
 * createTicketFromInboundEmail/appendInboundReply).
 *
 * PAS de point de score ici (16/09/2026, retiré) : un email envoyé au
 * support est un signal de demande d'assistance, pas d'intérêt commercial
 * — le compter dans le score d'intérêt (cf. lib/crmScoring.ts,
 * config.pointsInboundEmail) faussait le score à la hausse pour des
 * clients qui contactent simplement le support, sans rapport avec un achat.
 * config.pointsInboundEmail reste dans le paramétrage du scoring pour une
 * future source d'email entrant hors ticket (ex : réponse directe à une
 * campagne), si un tel signal est ajouté un jour.
 */
async function recordInboundEmail(prospectId: string, receivedAt: Date) {
  await prisma.crmProspect.update({
    where: { id: prospectId },
    data: { inboundReplyCount: { increment: 1 }, lastInboundReplyAt: receivedAt },
  });
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
  // Pas de tag [TKT-...] exploitable en amont (cf. appelants) : avant
  // d'ouvrir un nouveau ticket, on vérifie qu'il n'y a pas déjà un échange
  // ouvert avec cette personne sur le même sujet — sinon on y ajoute ce
  // message plutôt que de fragmenter la conversation en plusieurs tickets.
  const existing = await findTicketByEmailAndSubject(input.email, input.subject || "");
  if (existing) {
    await appendInboundReply(existing, {
      authorName: input.name || input.email,
      body: input.body,
      attachments: input.attachments,
      graphMessageId: input.graphMessageId,
    });
    return existing;
  }

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
          attachments: sanitizeTicketAttachments(input.attachments),
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
    variables: {
      nom: prospect.nom,
      secteur: prospect.secteur || "",
      numero: ticket.number,
      sujet: ticket.subject,
      statut: ticket.status,
      // Toujours "Non assigné" à la création (agentId n'est jamais renseigné
      // à ce stade) — pas de requête supplémentaire nécessaire.
      agent: "Non assigné",
    },
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
      attachments: sanitizeTicketAttachments(input.attachments),
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
    variables: {
      nom: ticket.contactName || ticket.contactEmail,
      secteur: "",
      numero: ticket.number,
      sujet: ticket.subject,
      statut: (data.status as string) || ticket.status,
      agent: await ticketAgentName(ticket.agentId),
    },
  }).catch((e) => console.error("[automation] crm.ticket_client_replied:", e));

  await recordInboundEmail(ticket.prospectId, new Date());
}

/**
 * Fermeture automatique des tickets "Attente client" restés sans nouvelle
 * activité (updatedAt) pendant TicketConfig.autoResolveAfterDays jours — cf.
 * discussion du 15/09/2026. Volontairement limité à ce seul statut : "En
 * attente"/"En cours" signifient qu'un agent doit encore agir, jamais
 * fermés tout seuls. Appelé périodiquement par runAutomationSweep() (cf.
 * automationScheduler, toutes les 15 min) — inerte tant que
 * autoResolveAfterDays n'est pas configuré (null/0, réglage par défaut).
 */
export async function sweepTicketAutoResolve(): Promise<void> {
  const config = await prisma.ticketConfig.findUnique({ where: { id: "singleton" } });
  const days = config?.autoResolveAfterDays;
  if (!days || days <= 0) return;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000);
  const stale = await prisma.crmTicket.findMany({ where: { status: "Attente client", updatedAt: { lte: cutoff } } });

  for (const ticket of stale) {
    try {
      await prisma.crmTicketMessage.create({
        data: {
          ticketId: ticket.id,
          authorType: "agent",
          authorName: "",
          kind: "system",
          body: `Statut : Attente client → Résolu (fermeture automatique après ${days} jour${days > 1 ? "s" : ""} sans réponse du client)`,
          attachments: [],
        },
      });
      const updated = await prisma.crmTicket.update({ where: { id: ticket.id }, data: { status: "Résolu" } });

      fireTrigger("crm.ticket_status_changed", {
        entityId: null,
        targetType: "crmTicket",
        targetId: updated.id + ":" + Date.now(), // pas de dédup — chaque transition doit pouvoir notifier
        recipient: { email: updated.contactEmail, phone: null },
        variables: {
          nom: updated.contactName || updated.contactEmail,
          secteur: "",
          ancienStatut: "Attente client",
          nouveauStatut: "Résolu",
          numero: updated.number,
          sujet: updated.subject,
          statut: "Résolu",
          agent: await ticketAgentName(updated.agentId),
        },
      }).catch((e) => console.error("[automation] crm.ticket_status_changed (auto-résolution):", e));
    } catch (e) {
      console.error(`[ticketInbound] échec auto-résolution du ticket ${ticket.id}:`, e);
    }
  }
}
