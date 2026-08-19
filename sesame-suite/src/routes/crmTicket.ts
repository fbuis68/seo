import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { fireTrigger } from "../lib/automation";
import { getSmtpConfig, sendEmailRaw } from "../lib/email";

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
    if (b.status) {
      data.status = b.status;
      if (b.status === "Fermé" && existing.status !== "Fermé") data.closedAt = new Date();
      if (b.status !== "Fermé" && existing.status === "Fermé") data.closedAt = null;
    }
    if (b.priority) data.priority = b.priority;
    if (b.type !== undefined) data.type = b.type || null;
    if (b.agentId !== undefined) data.agentId = b.agentId || null;
    if (b.tags !== undefined) data.tags = b.tags;

    const updated = await prisma.crmTicket.update({ where: { id: b.id }, data, include: TICKET_INCLUDE });
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
      const subject = `Re: ${ticket.subject} [#${ticket.id.slice(-6)}]`;
      const html = bodyText.replace(/\n/g, "<br>");
      await sendEmailRaw(null, ticket.contactEmail, subject, html, fromName, {
        fromEmailOverride: fromEmail,
        attachments: b.attachments,
      });
    }

    const message = await prisma.crmTicketMessage.create({
      data: { ticketId: ticket.id, authorType: "agent", authorName, kind, body: bodyText, attachments: b.attachments || [] },
    });

    const data: Record<string, unknown> = { updatedAt: new Date() };
    if (kind === "reply" && ticket.status !== "Fermé") data.status = "Attente client";
    await prisma.crmTicket.update({ where: { id: ticket.id }, data });

    res.status(201).json(shapeMessage(message));
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

    let prospect = await prisma.crmProspect.findFirst({ where: { email } });
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

    const ticket = await prisma.crmTicket.create({
      data: {
        prospectId: prospect.id,
        subject,
        contactEmail: email,
        contactName: name || null,
        messages: { create: { authorType: "client", authorName: name || email, kind: "reply", body: message, attachments: b.attachments || [] } },
      },
    });

    fireTrigger("crm.ticket_created", {
      entityId: null,
      targetType: "crmTicket",
      targetId: ticket.id,
      recipient: { email: null, phone: null },
      variables: { nom: prospect.nom, secteur: prospect.secteur || "" },
    }).catch((e) => console.error("[automation] crm.ticket_created:", e));

    res.status(201).json({ publicToken: ticket.publicToken });
  })
);

/** GET /wa/ticket/public?token=... — lecture seule côté client, ne renvoie
 * jamais les notes internes (kind="note", réservées à l'équipe support). */
crmTicketRouter.get(
  "/ticket/public",
  asyncHandler(async (req, res) => {
    const token = (req.query.token as string) || "";
    if (!token) throw new HttpError(400, "Lien invalide");
    const t = await prisma.crmTicket.findUnique({ where: { publicToken: token }, include: TICKET_INCLUDE });
    if (!t) throw new HttpError(404, "Lien invalide ou expiré");
    const shaped = shapeTicket(t);
    shaped.messages = shaped.messages.filter((m) => m.kind !== "note");
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

    await prisma.crmTicketMessage.create({
      data: { ticketId: t.id, authorType: "client", authorName: t.contactName || t.contactEmail, kind: "reply", body: bodyText, attachments: b.attachments || [] },
    });

    const data: Record<string, unknown> = { updatedAt: new Date() };
    if (t.status === "Fermé") {
      data.status = "En attente";
      data.closedAt = null;
    } else if (t.status !== "En attente") {
      data.status = "En attente";
    }
    await prisma.crmTicket.update({ where: { id: t.id }, data });

    fireTrigger("crm.ticket_client_replied", {
      entityId: null,
      targetType: "crmTicket",
      targetId: t.id + ":" + Date.now(), // pas de dédup — chaque relance client doit notifier
      recipient: { email: null, phone: null },
      variables: { nom: t.contactName || t.contactEmail, secteur: "" },
    }).catch((e) => console.error("[automation] crm.ticket_client_replied:", e));

    res.status(201).json({ ok: true });
  })
);
