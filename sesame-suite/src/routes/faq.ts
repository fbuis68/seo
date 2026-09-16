import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { generateFaqDraft } from "../lib/aiClaude";
import { reindexFaqEmbedding } from "../lib/aiIndexing";

/**
 * Module FAQ (§ LOT 1, étape 3 "capitalisation") — portée CRM/Sesame
 * uniquement, comme CrmTicket. Une FAQ générée par l'IA (cf.
 * /faq/generateFromTicket) naît toujours en status="draft" : elle n'est
 * indexée (embedding) et visible de l'assistant (§ étape 2, sources
 * possibles d'une réponse suggérée) qu'une fois publiée par un opérateur —
 * "une FAQ générée automatiquement ne doit jamais être publiée sans
 * validation humaine".
 */
export const faqRouter = Router();

function shapeFaq(f: {
  id: string;
  title: string;
  question: string;
  variants: string[];
  shortAnswer: string;
  detailedAnswer: string;
  procedure: string[];
  module: string | null;
  category: string | null;
  keywords: string[];
  tags: string[];
  status: string;
  publishedAt: Date | null;
  sourceTicketId: string | null;
  createdAt: Date;
  updatedAt: Date;
  sourceTicket?: { id: string; number: string; subject: string } | null;
}) {
  return {
    id: f.id,
    title: f.title,
    question: f.question,
    variants: f.variants,
    shortAnswer: f.shortAnswer,
    detailedAnswer: f.detailedAnswer,
    procedure: f.procedure,
    module: f.module || "",
    category: f.category || "",
    keywords: f.keywords,
    tags: f.tags,
    status: f.status,
    publishedAt: f.publishedAt,
    sourceTicketId: f.sourceTicketId,
    sourceTicketNumber: f.sourceTicket?.number || "",
    sourceTicketSubject: f.sourceTicket?.subject || "",
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

faqRouter.get(
  "/faq/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const status = (req.query.status as string) || undefined;
    const rows = await prisma.faq.findMany({
      where: status ? { status } : {},
      include: { sourceTicket: { select: { id: true, number: true, subject: true } } },
      orderBy: { updatedAt: "desc" },
    });
    res.json(rows.map(shapeFaq));
  })
);

faqRouter.get(
  "/faq/get",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.query.id as string) || "";
    const f = await prisma.faq.findUnique({ where: { id }, include: { sourceTicket: { select: { id: true, number: true, subject: true } } } });
    if (!f) throw new HttpError(404, "FAQ introuvable");
    res.json(shapeFaq(f));
  })
);

/**
 * POST /wa/faq/generateFromTicket { ticketId } — analyse le fil complet
 * d'un ticket résolu et crée un brouillon de FAQ. Fonctionne quel que soit
 * le statut du ticket (pas de blocage serveur) — le front réserve
 * l'affichage du bouton aux tickets Résolu/Fermé, seul contexte où la
 * capitalisation a du sens.
 */
faqRouter.post(
  "/faq/generateFromTicket",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const ticketId = (req.body.ticketId as string) || "";
    const ticket = await prisma.crmTicket.findUnique({ where: { id: ticketId }, include: { messages: { orderBy: { createdAt: "asc" } } } });
    if (!ticket) throw new HttpError(404, "Ticket introuvable");

    const threadText = ticket.messages
      .filter((m) => m.kind !== "system")
      .map((m) => `[${m.authorType === "client" ? "Client" : "Support"}] ${m.body}`)
      .join("\n\n");
    if (!threadText.trim()) throw new HttpError(400, "Ticket sans échange exploitable");

    const draft = await generateFaqDraft({ subject: ticket.subject, threadText });

    const faq = await prisma.faq.create({
      data: {
        title: draft.title || ticket.subject,
        question: draft.question,
        variants: draft.variants,
        shortAnswer: draft.shortAnswer,
        detailedAnswer: draft.detailedAnswer,
        procedure: draft.procedure,
        module: ticket.module || draft.module || null,
        category: draft.category || ticket.type || null,
        keywords: draft.keywords,
        tags: draft.tags,
        status: "draft",
        sourceTicketId: ticket.id,
        createdById: req.admin?.adminId || null,
      },
      include: { sourceTicket: { select: { id: true, number: true, subject: true } } },
    });
    res.status(201).json(shapeFaq(faq));
  })
);

interface UpdateBody {
  id: string;
  title?: string;
  question?: string;
  variants?: string[];
  shortAnswer?: string;
  detailedAnswer?: string;
  procedure?: string[];
  module?: string;
  category?: string;
  keywords?: string[];
  tags?: string[];
}

faqRouter.post(
  "/faq/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as UpdateBody;
    const existing = await prisma.faq.findUnique({ where: { id: b.id } });
    if (!existing) throw new HttpError(404, "FAQ introuvable");

    const data: Record<string, unknown> = {};
    if (b.title !== undefined) data.title = b.title;
    if (b.question !== undefined) data.question = b.question;
    if (b.variants !== undefined) data.variants = b.variants;
    if (b.shortAnswer !== undefined) data.shortAnswer = b.shortAnswer;
    if (b.detailedAnswer !== undefined) data.detailedAnswer = b.detailedAnswer;
    if (b.procedure !== undefined) data.procedure = b.procedure;
    if (b.module !== undefined) data.module = b.module || null;
    if (b.category !== undefined) data.category = b.category || null;
    if (b.keywords !== undefined) data.keywords = b.keywords;
    if (b.tags !== undefined) data.tags = b.tags;

    const updated = await prisma.faq.update({ where: { id: b.id }, data, include: { sourceTicket: { select: { id: true, number: true, subject: true } } } });
    // Une FAQ déjà publiée et modifiée doit repropager son embedding — sinon
    // la recherche sémantique continuerait de matcher sur l'ancien contenu.
    if (updated.status === "published") reindexFaqEmbedding(updated.id);
    res.json(shapeFaq(updated));
  })
);

faqRouter.post(
  "/faq/publish",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.faq.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "FAQ introuvable");
    if (!existing.shortAnswer.trim() || !existing.question.trim()) throw new HttpError(400, "Question et réponse courte requises avant publication");
    const updated = await prisma.faq.update({ where: { id }, data: { status: "published", publishedAt: new Date() } });
    reindexFaqEmbedding(updated.id);
    res.json(shapeFaq({ ...updated, sourceTicket: null }));
  })
);

faqRouter.post(
  "/faq/unpublish",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.faq.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "FAQ introuvable");
    const updated = await prisma.faq.update({ where: { id }, data: { status: "draft" } });
    res.json(shapeFaq({ ...updated, sourceTicket: null }));
  })
);

faqRouter.post(
  "/faq/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.faq.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "FAQ introuvable");
    await prisma.faq.delete({ where: { id } });
    res.json({ ok: true });
  })
);
