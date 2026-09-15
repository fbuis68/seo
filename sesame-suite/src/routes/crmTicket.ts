import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { getSmtpConfig, sendEmailRaw } from "../lib/email";
import { createTicketFromInboundEmail, appendInboundReply, sanitizeTicketAttachments } from "../lib/ticketInbound";
import { fireTrigger } from "../lib/automation";

/**
 * Module Tickets (support) — 19/08/2026. Portée CRM/Sesame uniquement
 * (entityId=null) : un contact hôtelier ouvre un incident depuis le widget
 * public (public/support.html), l'équipe Sesame le qualifie et y répond
 * depuis crm.html. Les routes /ticket/* (sans préfixe /crmTicket) sont
 * publiques, sans authentification — même convention que /wa/crmQuote/public
 * et /wa/crmQuote/sign pour la signature de devis.
 */
export const crmTicketRouter = Router();

const STATUSES = ["En attente", "En cours", "Attente client", "Résolu", "Fermé"];
const PRIORITIES = ["Basse", "Normale", "Haute", "Urgente"];

/**
 * GET/POST /wa/crmTicket/config — réglage du module (portée globale, pas par
 * établissement, cf. TicketConfig). Pour l'instant uniquement la fermeture
 * automatique après x jours en "Attente client" (cf. sweepTicketAutoResolve
 * dans lib/ticketInbound.ts) — null/0 = désactivé.
 */
crmTicketRouter.get(
  "/crmTicket/config",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const config = await prisma.ticketConfig.findUnique({ where: { id: "singleton" } });
    res.json({ autoResolveAfterDays: config?.autoResolveAfterDays ?? null });
  })
);

crmTicketRouter.post(
  "/crmTicket/config",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const raw = req.body.autoResolveAfterDays;
    let autoResolveAfterDays: number | null = null;
    if (raw !== null && raw !== undefined && raw !== "") {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "Valeur invalide pour autoResolveAfterDays");
      autoResolveAfterDays = Math.round(n) || null; // 0 traité comme désactivé
    }
    const config = await prisma.ticketConfig.upsert({
      where: { id: "singleton" },
      update: { autoResolveAfterDays },
      create: { id: "singleton", autoResolveAfterDays },
    });
    res.json({ autoResolveAfterDays: config.autoResolveAfterDays ?? null });
  })
);

function shapeMessage(m: {
  id: string;
  authorType: string;
  authorName: string | null;
  kind: string;
  body: string;
  attachments: unknown;
  createdAt: Date;
}) {
  return {
    id: m.id,
    authorType: m.authorType,
    authorName: m.authorName || "",
    kind: m.kind,
    body: m.body,
    attachments: (m.attachments as string[]) || [],
    createdAt: m.createdAt,
  };
}

function shapeTicket(t: {
  id: string;
  number: string;
  prospectId: string;
  agentId: string | null;
  subject: string;
  status: string;
  priority: string;
  type: string | null;
  tags: unknown;
  contactEmail: string;
  contactName: string | null;
  publicToken: string;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  prospect?: { id: string; nom: string } | null;
  agent?: { id: string; name: string | null; email: string } | null;
  messages?: Parameters<typeof shapeMessage>[0][];
}) {
  return {
    id: t.id,
    number: t.number,
    prospectId: t.prospectId,
    prospectNom: t.prospect ? t.prospect.nom : "",
    agentId: t.agentId,
    agentName: t.agent ? t.agent.name || t.agent.email : "",
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    type: t.type || "",
    tags: (t.tags as string[]) || [],
    contactEmail: t.contactEmail,
    contactName: t.contactName || "",
    publicToken: t.publicToken,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    closedAt: t.closedAt,
    messages: (t.messages || []).map(shapeMessage),
  };
}

const TICKET_INCLUDE = {
  prospect: { select: { id: true, nom: true } },
  agent: { select: { id: true, name: true, email: true } },
  messages: { orderBy: { createdAt: "asc" as const } },
};

// ═══════════════════════════ ADMIN (CRM Sesame) ═══════════════════════════

crmTicketRouter.get(
  "/crmTicket/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const prospectId = (req.query.prospectId as string) || undefined;
    const status = (req.query.status as string) || undefined;
    const rows = await prisma.crmTicket.findMany({
      where: { ...(prospectId ? { prospectId } : {}), ...(status ? { status } : {}) },
      include: TICKET_INCLUDE,
      orderBy: { updatedAt: "desc" },
    });
    res.json(rows.map(shapeTicket));
  })
);

crmTicketRouter.get(
  "/crmTicket/get",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.query.id as string) || "";
    const t = await prisma.crmTicket.findUnique({ where: { id }, include: TICKET_INCLUDE });
    if (!t) throw new HttpError(404, "Ticket introuvable");
    res.json(shapeTicket(t));
  })
);

interface UpdateBody {
  id: string;
  status?: string;
  priority?: string;
  type?: string;
  agentId?: string | null;
  tags?: string[];
}

/**
 * Formate le nom d'un agent pour le journal de modifications — "Non
 * assigné" pour null, l'id brut en repli si l'agent a depuis été
 * supprimé (jamais bloquant : le journal reste lisible même sur un compte
 * disparu).
 */
function formatAgentName(id: string | null, agents: { id: string; name: string | null; email: string }[]): string {
  if (!id) return "Non assigné";
  const a = agents.find((x) => x.id === id);
  return a ? a.name || a.email : id;
}

crmTicketRouter.post(
  "/crmTicket/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as UpdateBody;
    const existing = await prisma.crmTicket.findUnique({ where: { id: b.id } });
    if (!existing) throw new HttpError(404, "Ticket introuvable");
    if (b.status && !STATUSES.includes(b.status)) throw new HttpError(400, "Statut invalide");
    if (b.priority && !PRIORITIES.includes(b.priority)) throw new HttpError(400, "Priorité invalide");

    const data: Record<string, unknown> = {};
    // Journal des changements de champs (statut/priorité/type/affectation) —
    // un message kind="system" dans le fil de discussion, au même titre
    // qu'une réponse ou une note interne, pour que l'historique de
    // traitement du ticket reste visible sans écran séparé. Une ligne par
    // champ effectivement modifié (jamais si la valeur envoyée est
    // identique à l'existante — le front réenvoie tous les champs à chaque
    // changement d'un seul select).
    const changeLines: string[] = [];

    if (b.status && b.status !== existing.status) {
      changeLines.push(`Statut : ${existing.status} → ${b.status}`);
      data.status = b.status;
      if (b.status === "Fermé" && existing.status !== "Fermé") data.closedAt = new Date();
      if (b.status !== "Fermé" && existing.status === "Fermé") data.closedAt = null;
    }
    if (b.priority && b.priority !== existing.priority) {
      changeLines.push(`Priorité : ${existing.priority} → ${b.priority}`);
      data.priority = b.priority;
    }
    if (b.type !== undefined && (b.type || null) !== existing.type) {
      changeLines.push(`Type : ${existing.type || "—"} → ${b.type || "—"}`);
      data.type = b.type || null;
    }
    let agentNames: { id: string; name: string | null; email: string }[] = [];
    if (b.agentId !== undefined && (b.agentId || null) !== existing.agentId) {
      const ids = [existing.agentId, b.agentId].filter((v): v is string => !!v);
      agentNames = ids.length ? await prisma.adminUser.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }) : [];
      changeLines.push(`Affectation : ${formatAgentName(existing.agentId, agentNames)} → ${formatAgentName(b.agentId || null, agentNames)}`);
      data.agentId = b.agentId || null;
    }
    if (b.tags !== undefined) data.tags = b.tags;

    await prisma.crmTicket.update({ where: { id: b.id }, data });

    if (changeLines.length) {
      const actor = req.admin ? await prisma.adminUser.findUnique({ where: { id: req.admin.adminId }, select: { name: true, email: true } }) : null;
      await prisma.crmTicketMessage.create({
        data: {
          ticketId: b.id,
          authorType: "agent",
          authorName: actor ? actor.name || actor.email : "",
          kind: "system",
          body: changeLines.join("\n"),
          attachments: [],
        },
      });
    }

    const updated = await prisma.crmTicket.findUnique({ where: { id: b.id }, include: TICKET_INCLUDE });
    if (!updated) throw new HttpError(404, "Ticket introuvable");

    if (b.status && b.status !== existing.status) {
      fireTrigger("crm.ticket_status_changed", {
        entityId: null,
        targetType: "crmTicket",
        targetId: updated.id + ":" + Date.now(), // pas de dédup — chaque transition doit pouvoir notifier
        recipient: { email: updated.contactEmail, phone: null },
        variables: {
          nom: updated.contactName || updated.contactEmail,
          secteur: "",
          ancienStatut: existing.status,
          nouveauStatut: updated.status,
          numero: updated.number,
          sujet: updated.subject,
          statut: updated.status,
          agent: updated.agent ? updated.agent.name || updated.agent.email : "Non assigné",
        },
      }).catch((e) => console.error("[automation] crm.ticket_status_changed:", e));
    }

    res.json(shapeTicket(updated));
  })
);

interface ReplyBody {
  id: string;
  body: string;
  attachments?: string[];
  kind: "reply" | "note";
}

/**
 * POST /wa/crmTicket/reply — un agent répond ou ajoute une note interne.
 * kind="reply" envoie un vrai email au contact (adresse support si
 * configurée, sinon l'adresse générale — cf. Canaux) et bascule le ticket
 * en "Attente client" (sauf s'il est déjà fermé). kind="note" n'envoie
 * jamais rien, ticket inchangé.
 */
crmTicketRouter.post(
  "/crmTicket/reply",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as ReplyBody;
    const ticket = await prisma.crmTicket.findUnique({ where: { id: b.id } });
    if (!ticket) throw new HttpError(404, "Ticket introuvable");
    const bodyText = (b.body || "").trim();
    if (!bodyText) throw new HttpError(400, "Message requis");
    const kind = b.kind === "note" ? "note" : "reply";

    const admin = req.admin ? await prisma.adminUser.findUnique({ where: { id: req.admin.adminId }, select: { name: true, email: true } }) : null;
    const authorName = admin ? admin.name || admin.email : "";

    if (kind === "reply") {
      const smtp = await getSmtpConfig(null);
      const fromName = smtp?.supportFromName || smtp?.fromName || undefined;
      const fromEmail = smtp?.supportFromEmail || undefined;
      const subject = `Re: ${ticket.subject} [${ticket.number}]`;
      const html = bodyText.replace(/\n/g, "<br>");
      await sendEmailRaw(null, ticket.contactEmail, subject, html, fromName, {
        fromEmailOverride: fromEmail,
        attachments: b.attachments,
      });
    }

    const message = await prisma.crmTicketMessage.create({
      data: { ticketId: ticket.id, authorType: "agent", authorName, kind, body: bodyText, attachments: sanitizeTicketAttachments(b.attachments) },
    });

    const data: Record<string, unknown> = { updatedAt: new Date() };
    if (kind === "reply" && ticket.status !== "Fermé") data.status = "Attente client";
    await prisma.crmTicket.update({ where: { id: ticket.id }, data });

    res.status(201).json(shapeMessage(message));
  })
);

interface BulkDeleteBody {
  ids: string[];
}

/**
 * POST /wa/crmTicket/bulkDelete — suppression groupée depuis la grille
 * (sélection multiple, cf. public/crm.html). Les messages liés partent en
 * cascade (onDelete: Cascade sur CrmTicketMessage.ticket).
 */
crmTicketRouter.post(
  "/crmTicket/bulkDelete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const raw = (req.body as BulkDeleteBody).ids;
    const ids = Array.isArray(raw) ? [...new Set(raw.filter((id): id is string => typeof id === "string" && !!id))] : [];
    if (!ids.length) throw new HttpError(400, "Aucun ticket sélectionné");
    const { count } = await prisma.crmTicket.deleteMany({ where: { id: { in: ids } } });
    res.json({ ok: true, deleted: count });
  })
);

interface MergeBody {
  targetId: string;
  sourceIds: string[];
}

/**
 * POST /wa/crmTicket/merge — fusionne un ou plusieurs tickets (sourceIds)
 * dans un ticket cible (targetId) : les messages des tickets source sont
 * rattachés au ticket cible (createdAt d'origine conservé, donc le fil
 * reste chronologique), un message système trace la fusion, puis les
 * tickets source (désormais vides) sont supprimés. Les tags des tickets
 * source sont fusionnés (union) dans ceux du ticket cible.
 */
crmTicketRouter.post(
  "/crmTicket/merge",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as MergeBody;
    const targetId = (b.targetId || "").trim();
    const sourceIds = Array.isArray(b.sourceIds)
      ? [...new Set(b.sourceIds.filter((id): id is string => typeof id === "string" && !!id && id !== targetId))]
      : [];
    if (!targetId) throw new HttpError(400, "Ticket cible requis");
    if (!sourceIds.length) throw new HttpError(400, "Sélectionnez au moins un ticket à fusionner");

    const target = await prisma.crmTicket.findUnique({ where: { id: targetId } });
    if (!target) throw new HttpError(404, "Ticket cible introuvable");
    const sources = await prisma.crmTicket.findMany({ where: { id: { in: sourceIds } } });
    if (!sources.length) throw new HttpError(404, "Tickets à fusionner introuvables");

    const actor = req.admin ? await prisma.adminUser.findUnique({ where: { id: req.admin.adminId }, select: { name: true, email: true } }) : null;
    const actorName = actor ? actor.name || actor.email : "";
    const mergedTags = new Set([...((target.tags as string[]) || []), ...sources.flatMap((s) => (s.tags as string[]) || [])]);
    const summary = sources.map((s) => `${s.number} (${s.subject})`).join(", ");
    const sourceIdsFound = sources.map((s) => s.id);

    const updated = await prisma.$transaction(async (tx) => {
      await tx.crmTicketMessage.updateMany({ where: { ticketId: { in: sourceIdsFound } }, data: { ticketId: targetId } });
      await tx.crmTicketMessage.create({
        data: {
          ticketId: targetId,
          authorType: "agent",
          authorName: actorName,
          kind: "system",
          body: `Fusion : ${summary} rattaché${sources.length > 1 ? "s" : ""} à ce ticket.`,
          attachments: [],
        },
      });
      await tx.crmTicket.deleteMany({ where: { id: { in: sourceIdsFound } } });
      return tx.crmTicket.update({
        where: { id: targetId },
        data: { tags: [...mergedTags], updatedAt: new Date() },
        include: TICKET_INCLUDE,
      });
    });

    res.json(shapeTicket(updated));
  })
);

// ═══════════════════════════ PUBLIC (widget client) ═══════════════════════

interface CreateBody {
  email: string;
  name?: string;
  subject: string;
  message: string;
  attachments?: string[];
}

/**
 * POST /wa/ticket/create — public, sans authentification. Retrouve le
 * prospect par email (même logique que POST /contact) ou en crée un minimal
 * si l'email est inconnu, pour qu'un client pas encore suivi au CRM puisse
 * quand même ouvrir un ticket.
 */
crmTicketRouter.post(
  "/ticket/create",
  asyncHandler(async (req, res) => {
    const b = req.body as CreateBody;
    const email = (b.email || "").trim().toLowerCase();
    const name = (b.name || "").trim();
    const subject = (b.subject || "").trim();
    const message = (b.message || "").trim();
    if (!email || !email.includes("@")) throw new HttpError(400, "Email valide requis");
    if (!subject) throw new HttpError(400, "Sujet requis");
    if (!message) throw new HttpError(400, "Message requis");

    const ticket = await createTicketFromInboundEmail({ email, name, subject, body: message, attachments: b.attachments });

    res.status(201).json({ publicToken: ticket.publicToken, number: ticket.number });
  })
);

/** GET /wa/ticket/public?token=... — lecture seule côté client, ne renvoie
 * jamais les échanges internes : ni les notes (kind="note", réservées à
 * l'équipe support), ni le journal des changements de champs (kind="system",
 * qui expose des détails opérationnels internes — affectation, priorité...
 * pas destinés au client). */
crmTicketRouter.get(
  "/ticket/public",
  asyncHandler(async (req, res) => {
    const token = (req.query.token as string) || "";
    if (!token) throw new HttpError(400, "Lien invalide");
    const t = await prisma.crmTicket.findUnique({ where: { publicToken: token }, include: TICKET_INCLUDE });
    if (!t) throw new HttpError(404, "Lien invalide ou expiré");
    const shaped = shapeTicket(t);
    shaped.messages = shaped.messages.filter((m) => m.kind !== "note" && m.kind !== "system");
    res.json(shaped);
  })
);

interface PublicReplyBody {
  token: string;
  body: string;
  attachments?: string[];
}

/** POST /wa/ticket/publicReply — le client complète son ticket (note,
 * image) via le lien permanent. Un ticket fermé est rouvert automatiquement
 * — un client qui revient sur un incident qu'on croyait résolu, c'est le
 * signal même qu'il ne l'est pas. */
crmTicketRouter.post(
  "/ticket/publicReply",
  asyncHandler(async (req, res) => {
    const b = req.body as PublicReplyBody;
    const bodyText = (b.body || "").trim();
    if (!bodyText) throw new HttpError(400, "Message requis");
    const t = await prisma.crmTicket.findUnique({ where: { publicToken: b.token || "" } });
    if (!t) throw new HttpError(404, "Lien invalide ou expiré");

    await appendInboundReply(t, { body: bodyText, attachments: b.attachments });

    res.status(201).json({ ok: true });
  })
);
