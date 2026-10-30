import { Router } from "express";
import crypto from "node:crypto";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { ONBOARDING_MODULES } from "./onboarding";
import { nextSequenceValue } from "../lib/sequence";
import { sendMessage } from "../lib/messaging";
import { getSmtpConfig } from "../lib/email";
import { getRecordingStream } from "../lib/graphMeetings";
import { recordScoreEvent, ScoreEventType } from "../lib/crmScoring";

/**
 * Devis — écran CRM à part entière (refonte du 22/10/2026, reprend
 * scrupuleusement la structure de la maquette fournie par le client). Un
 * devis appartient d'abord à un CLIENT (CrmProspect, obligatoire) ; son
 * rattachement à une affaire (CrmDeal) est optionnel et se fait a
 * posteriori (§ demande client : "pas de création à partir de l'affaire, on
 * la rattachera ensuite") via POST /crmQuote/attachDeal. "Souple" : lignes
 * libres en JSON, mélange de modules Sesame et de lignes personnalisées.
 * "Automatique" : le catalogue de modules proposé pour pré-remplir
 * l'onglet Logiciel vient de la même source de vérité tarifaire que le
 * wizard d'inscription (ONBOARDING_MODULES + PricingConfig), pas d'une
 * grille dupliquée qui risquerait de diverger.
 */
export const crmQuoteRouter = Router();

// materiel (Équipements) | logiciel (Logiciel/abonnement) | service (Mise en
// place : installation, formation, déploiement...) | autre (lignes libres) —
// cf. CrmProduct.category, même nomenclature, pour que le constructeur de
// devis range chaque ligne sous le bon onglet (maquette devis Sesame, 22/10/2026).
export type QuoteLineCategory = "materiel" | "logiciel" | "service" | "autre";

interface QuoteLine {
  id?: string;
  label: string;
  description?: string; // sous-texte verbeux affiché sous le libellé (cf. devis Sesame réels)
  qty: number;
  unitPrice: number | null; // null = "à chiffrer" (tarif non renseigné), cf. maquette
  recurring: boolean; // true = mensuel (abonnement), false = ponctuel (équipements/mise en place)
  category?: QuoteLineCategory;
  // Onglet Équipements uniquement — sépare "Équiper les accès" (main) de
  // "Accessoires & connectivité" (accessory), mêmes deux sections que la
  // maquette, purement indicatif/affichage.
  group?: "main" | "accessory";
  // Produit catalogue (CrmProduct) d'origine d'une ligne Équipements/
  // Accessoires (cf. dqAddHardware/dqAddAccessory, public/crm.html) — sert
  // à résoudre CrmProduct.documentId côté espace client (GET
  // /crmQuote/public), jamais utilisé pour le calcul.
  productId?: string;
}

// Valeurs brutes des calculateurs des onglets Logiciel + Mise en place —
// mêmes champs que la maquette (id #sq-xxx), stockées telles quelles pour
// rester ré-éditables (contrairement à des lignes dérivées, qu'on ne peut
// pas "dé-calculer").
interface QuoteConfig {
  license?: number;
  pmsInterface?: string;
  platformSetup?: number;
  smsQty?: number;
  smsUnitPrice?: number;
  subscriptionStart?: string;
  timeMode?: string;
  minutesPerAccess?: number;
  hoursPerDay?: number;
  installDays?: number;
  dayRate?: number;
  setupPerAccess?: number;
  visitFee?: number;
  trainingFee?: number;
  travelFee?: number;
  devDays?: number;
  testDays?: number;
  devRate?: number;
  specificScope?: string;
  overrides?: Record<string, Partial<Pick<QuoteLine, "label" | "qty" | "unitPrice">>>;
  [k: string]: unknown;
}

function num(v: unknown): number {
  return Math.max(0, Number(v) || 0);
}

/**
 * Port serveur EXACT de dqCalculatorLines() (public/crm.html) — les lignes
 * dérivées des calculateurs Logiciel/Mise en place (licence, plateforme,
 * SMS, visite, installation, formation, déplacement, développement
 * spécifique) ne sont JAMAIS stockées dans CrmQuote.lines (recalculées à la
 * volée côté constructeur) : la page publique de signature et l'email
 * envoyé au client doivent donc les recalculer ici aussi, sans quoi le
 * total affiché au client serait incomplet (ne compterait que le matériel/
 * logiciel/lignes libres, pas la main d'œuvre).
 */
// Étape "3. Mise en place" retirée côté CRM (23/10/2026, demande client) —
// setup/visite/installation/formation/déplacement/développement spécifique
// ne sont plus dérivées d'un calculateur (hardwareLines/config.installDays
// etc. ne sont donc plus utilisés) : ce sont désormais de simples lignes
// manuelles (category="service"), saisies directement dans le Document et
// envoyées telles quelles dans storedLines — même logique que
// public/crm.html dqCalculatorLines(), qui doit rester en phase avec cette
// fonction (pas de build partagé entre les deux).
function expandQuoteLines(storedLines: QuoteLine[], _hardwareLines: QuoteLine[], config: QuoteConfig): QuoteLine[] {
  const overrides = config.overrides || {};
  const rows: QuoteLine[] = [];
  const add = (id: string, label: string, qty: number, unitPrice: number, recurring = false) => {
    if (qty > 0) rows.push({ id, label, qty, unitPrice, recurring, category: recurring ? "logiciel" : "service", ...(overrides[id] || {}) });
  };
  add("platform", "Paramétrage plateforme", 1, num(config.platformSetup));
  add("sms", "SMS prépayés", num(config.smsQty), num(config.smsUnitPrice));
  add("license", "Licence clés, support" + (config.pmsInterface === "Misterbooking" ? " et interface Misterbooking" : ""), 1, num(config.license), true);
  const storedWithOverrides = storedLines.map((l) => ({ ...l, ...(l.id ? overrides[l.id] : undefined) }));
  return [...storedWithOverrides, ...rows];
}

function shapeQuote(q: {
  id: string;
  dealId: string | null;
  deal?: { id: string; title: string } | null;
  prospectId: string;
  prospect?: { id: string; nom: string; email: string | null } | null;
  number: string;
  title: string;
  status: string;
  lines: unknown;
  config: unknown;
  introText: string | null;
  mentionsText: string | null;
  termsText: string | null;
  discountPct: number;
  vatPct: number;
  depositPct: number;
  notes: string | null;
  sentAt: Date | null;
  signToken: string | null;
  attachedDocumentIds: string[];
  attachedMeetingIds: string[];
  attachedMeetingSummaryIds: string[];
  attachedMeetingVideoIds: string[];
  createdAt: Date;
  updatedAt: Date;
}) {
  const lines = (q.lines as QuoteLine[]) || [];
  const config = (q.config as QuoteConfig) || {};
  const hardwareLines = lines.filter((l) => l.category === "materiel" && l.group !== "accessory");
  // Totaux calculés sur les lignes DÉRIVÉES (manuel + calculateurs
  // Logiciel/Mise en place) — même source que la page publique de
  // signature/l'email envoyé, pour que la liste des devis (montant affiché)
  // ne sous-évalue jamais le vrai total (cf. expandQuoteLines ci-dessus).
  const totals = quoteTotals(expandQuoteLines(lines, hardwareLines, config), q.discountPct, q.vatPct, q.depositPct);
  return {
    id: q.id,
    dealId: q.dealId,
    dealTitle: q.deal?.title || null,
    prospectId: q.prospectId,
    prospectNom: q.prospect?.nom || "",
    number: q.number,
    title: q.title || "",
    status: q.status,
    lines,
    config,
    introText: q.introText || "",
    mentionsText: q.mentionsText || "",
    termsText: q.termsText || "",
    discountPct: q.discountPct,
    vatPct: q.vatPct,
    depositPct: q.depositPct,
    totals,
    notes: q.notes || "",
    sentAt: q.sentAt,
    signToken: q.signToken,
    attachedDocumentIds: q.attachedDocumentIds,
    attachedMeetingIds: q.attachedMeetingIds,
    attachedMeetingSummaryIds: q.attachedMeetingSummaryIds,
    attachedMeetingVideoIds: q.attachedMeetingVideoIds,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
  };
}

/** GET /wa/crmQuote/catalog — catalogue de modules + prix pour pré-remplir un devis. */
crmQuoteRouter.get(
  "/crmQuote/catalog",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const cfg = await prisma.pricingConfig.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
    const overrides = (cfg.modulePrices as Record<string, number>) || {};
    res.json({
      basePrice: cfg.basePrice,
      modules: ONBOARDING_MODULES.map((m) => ({ k: m.k, label: m.label, desc: m.desc, price: overrides[m.k] ?? m.price })),
    });
  })
);

/**
 * Numéro de devis lisible (ex : DEV-2026-0001), compté par année — cf.
 * nextSequenceValue (lib/sequence.ts), un compteur atomique Postgres.
 */
async function nextQuoteNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const n = await nextSequenceValue(`quote-${year}`);
  return `DEV-${year}-${String(n).padStart(4, "0")}`;
}

const QUOTE_INCLUDE = { deal: { select: { id: true, title: true } }, prospect: { select: { id: true, nom: true, email: true } } } as const;

/**
 * GET /wa/crmQuote/list — écran "Devis" à part entière (22/10/2026) : liste
 * globale, filtrable par client/affaire/statut/recherche texte — plus
 * besoin d'un dealId pour lister (contrairement à avant la refonte).
 */
crmQuoteRouter.get(
  "/crmQuote/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const prospectId = (req.query.prospectId as string) || undefined;
    const dealId = (req.query.dealId as string) || undefined;
    const status = (req.query.status as string) || undefined;
    const q = ((req.query.q as string) || "").trim();
    const rows = await prisma.crmQuote.findMany({
      where: {
        prospectId,
        dealId,
        status,
        ...(q
          ? {
              OR: [
                { number: { contains: q, mode: "insensitive" } },
                { title: { contains: q, mode: "insensitive" } },
                { prospect: { nom: { contains: q, mode: "insensitive" } } },
              ],
            }
          : {}),
      },
      include: QUOTE_INCLUDE,
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    res.json(rows.map(shapeQuote));
  })
);

crmQuoteRouter.get(
  "/crmQuote/get",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.query.id as string) || "";
    const row = await prisma.crmQuote.findUnique({ where: { id }, include: QUOTE_INCLUDE });
    if (!row) throw new HttpError(404, "Devis introuvable");
    res.json(shapeQuote(row));
  })
);

interface QuoteBody {
  prospectId: string;
  title?: string;
  lines?: QuoteLine[];
  config?: QuoteConfig;
  introText?: string;
  mentionsText?: string;
  termsText?: string;
  discountPct?: number;
  vatPct?: number;
  depositPct?: number;
  status?: string;
  attachedDocumentIds?: string[];
  attachedMeetingIds?: string[];
  attachedMeetingSummaryIds?: string[];
  attachedMeetingVideoIds?: string[];
}

crmQuoteRouter.post(
  "/crmQuote/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as QuoteBody;
    if (!b.prospectId) throw new HttpError(400, "Client requis");
    const prospect = await prisma.crmProspect.findUnique({ where: { id: b.prospectId } });
    if (!prospect) throw new HttpError(404, "Client introuvable");

    const number = await nextQuoteNumber();
    const row = await prisma.crmQuote.create({
      data: {
        prospectId: b.prospectId,
        title: b.title?.trim() || "",
        lines: (b.lines || []) as object[],
        config: (b.config || {}) as object,
        introText: b.introText,
        mentionsText: b.mentionsText,
        termsText: b.termsText,
        number,
        discountPct: b.discountPct ?? 0,
        vatPct: b.vatPct ?? 20,
        depositPct: b.depositPct ?? 0,
        attachedDocumentIds: Array.isArray(b.attachedDocumentIds) ? b.attachedDocumentIds : [],
        attachedMeetingIds: Array.isArray(b.attachedMeetingIds) ? b.attachedMeetingIds : [],
        attachedMeetingSummaryIds: Array.isArray(b.attachedMeetingSummaryIds) ? b.attachedMeetingSummaryIds : [],
        attachedMeetingVideoIds: Array.isArray(b.attachedMeetingVideoIds) ? b.attachedMeetingVideoIds : [],
      },
      include: QUOTE_INCLUDE,
    });
    res.status(201).json(shapeQuote(row));
  })
);

crmQuoteRouter.post(
  "/crmQuote/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const { id, ...b } = req.body as QuoteBody & { id: string };
    if (!id) throw new HttpError(400, "id requis");
    const existing = await prisma.crmQuote.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Devis introuvable");
    const row = await prisma.crmQuote.update({
      where: { id },
      data: {
        title: b.title === undefined ? undefined : b.title.trim(),
        lines: b.lines === undefined ? undefined : (b.lines as object[]),
        config: b.config === undefined ? undefined : (b.config as object),
        introText: b.introText,
        mentionsText: b.mentionsText,
        termsText: b.termsText,
        discountPct: b.discountPct,
        vatPct: b.vatPct,
        depositPct: b.depositPct,
        status: b.status,
        sentAt: b.status === "envoyé" && existing.status !== "envoyé" ? new Date() : undefined,
        attachedDocumentIds: Array.isArray(b.attachedDocumentIds) ? b.attachedDocumentIds : undefined,
        attachedMeetingIds: Array.isArray(b.attachedMeetingIds) ? b.attachedMeetingIds : undefined,
        attachedMeetingSummaryIds: Array.isArray(b.attachedMeetingSummaryIds) ? b.attachedMeetingSummaryIds : undefined,
        attachedMeetingVideoIds: Array.isArray(b.attachedMeetingVideoIds) ? b.attachedMeetingVideoIds : undefined,
      },
      include: QUOTE_INCLUDE,
    });
    res.json(shapeQuote(row));
  })
);

/**
 * POST /wa/crmQuote/attachDeal — rattache (ou détache, dealId=null) un
 * devis à une affaire — action séparée de la création (§ demande client
 * 22/10/2026 : "pas de création à partir de l'affaire, on la rattachera
 * ensuite"). L'affaire doit appartenir au MÊME client que le devis, sans
 * quoi le rattachement n'aurait pas de sens (cf. CrmDeal.prospectId).
 */
crmQuoteRouter.post(
  "/crmQuote/attachDeal",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const dealId = (req.body.dealId as string) || null;
    const existing = await prisma.crmQuote.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Devis introuvable");
    if (dealId) {
      const deal = await prisma.crmDeal.findUnique({ where: { id: dealId } });
      if (!deal) throw new HttpError(404, "Affaire introuvable");
      if (deal.prospectId !== existing.prospectId) throw new HttpError(400, "Cette affaire n'appartient pas au même client que le devis");
    }
    const row = await prisma.crmQuote.update({ where: { id }, data: { dealId }, include: QUOTE_INCLUDE });
    res.json(shapeQuote(row));
  })
);

crmQuoteRouter.post(
  "/crmQuote/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmQuote.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Devis introuvable");
    await prisma.crmQuote.delete({ where: { id } });
    res.json({ ok: true });
  })
);

/**
 * POST /wa/crmQuote/duplicate — clone un devis existant (ex. après une
 * remise négociée) : même client/affaire/lignes/config/textes, nouveau
 * numéro, statut réinitialisé à "brouillon", pas de lien vers la
 * signature/l'envoi du devis d'origine.
 */
crmQuoteRouter.post(
  "/crmQuote/duplicate",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmQuote.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Devis introuvable");
    const number = await nextQuoteNumber();
    const row = await prisma.crmQuote.create({
      data: {
        prospectId: existing.prospectId,
        dealId: existing.dealId,
        title: existing.title,
        number,
        lines: existing.lines as object[],
        config: existing.config as object,
        introText: existing.introText,
        mentionsText: existing.mentionsText,
        termsText: existing.termsText,
        discountPct: existing.discountPct,
        vatPct: existing.vatPct,
        depositPct: existing.depositPct,
      },
      include: QUOTE_INCLUDE,
    });
    res.status(201).json(shapeQuote(row));
  })
);

// ── Modèles de devis récurrents ──
// Objectif explicite : gagner du temps sur des devis verbeux et répétitifs
// — un modèle porte déjà tous les libellés/descriptions/prix, il ne reste
// qu'à ajuster les quantités à la marge lors de la création d'un devis.

function shapeTemplate(t: {
  id: string;
  name: string;
  lines: unknown;
  notes: string | null;
  secteur: string | null;
  introText: string | null;
  mentionsText: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: t.id,
    name: t.name,
    lines: (t.lines as QuoteLine[]) || [],
    notes: t.notes || "",
    secteur: t.secteur || "",
    introText: t.introText || "",
    mentionsText: t.mentionsText || "",
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

crmQuoteRouter.get(
  "/crmQuoteTemplate/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.crmQuoteTemplate.findMany({ orderBy: { name: "asc" } });
    res.json(rows.map(shapeTemplate));
  })
);

interface TemplateBody {
  name: string;
  lines?: QuoteLine[];
  notes?: string;
  secteur?: string;
  introText?: string;
  mentionsText?: string;
}

crmQuoteRouter.post(
  "/crmQuoteTemplate/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as TemplateBody;
    if (!b.name || !b.name.trim()) throw new HttpError(400, "Nom du modèle requis");
    const row = await prisma.crmQuoteTemplate.create({
      data: {
        name: b.name.trim(),
        lines: (b.lines || []) as object[],
        notes: b.notes,
        secteur: b.secteur || undefined,
        introText: b.introText || undefined,
        mentionsText: b.mentionsText || undefined,
      },
    });
    res.status(201).json(shapeTemplate(row));
  })
);

crmQuoteRouter.post(
  "/crmQuoteTemplate/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const { id, ...b } = req.body as TemplateBody & { id: string };
    if (!id) throw new HttpError(400, "id requis");
    if (b.name !== undefined && !b.name.trim()) throw new HttpError(400, "Le nom ne peut pas être vide");
    const existing = await prisma.crmQuoteTemplate.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Modèle introuvable");
    const row = await prisma.crmQuoteTemplate.update({
      where: { id },
      data: {
        name: b.name?.trim(),
        lines: b.lines === undefined ? undefined : (b.lines as object[]),
        notes: b.notes,
        secteur: b.secteur === undefined ? undefined : b.secteur || null,
        introText: b.introText === undefined ? undefined : b.introText || null,
        mentionsText: b.mentionsText === undefined ? undefined : b.mentionsText || null,
      },
    });
    res.json(shapeTemplate(row));
  })
);

crmQuoteRouter.post(
  "/crmQuoteTemplate/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmQuoteTemplate.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Modèle introuvable");
    await prisma.crmQuoteTemplate.delete({ where: { id } });
    res.json({ ok: true });
  })
);

// ── Bibliothèque de clauses (onglet Document, "Mentions spécifiques") ──
// § demande client 22/10/2026 : remplace les 4 clauses figées en dur côté
// client par une liste éditable, pour en ajouter facilement.

function shapeClause(c: { id: string; label: string; text: string; order: number; createdAt: Date; updatedAt: Date }) {
  return { id: c.id, label: c.label, text: c.text, order: c.order, createdAt: c.createdAt, updatedAt: c.updatedAt };
}

crmQuoteRouter.get(
  "/crmQuoteClause/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.crmQuoteClause.findMany({ orderBy: { order: "asc" } });
    res.json(rows.map(shapeClause));
  })
);

interface ClauseBody {
  label: string;
  text: string;
}

crmQuoteRouter.post(
  "/crmQuoteClause/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as ClauseBody;
    if (!b.label || !b.label.trim()) throw new HttpError(400, "Libellé requis");
    if (!b.text || !b.text.trim()) throw new HttpError(400, "Texte requis");
    const agg = await prisma.crmQuoteClause.aggregate({ _max: { order: true } });
    const row = await prisma.crmQuoteClause.create({
      data: { label: b.label.trim(), text: b.text.trim(), order: (agg._max.order ?? -1) + 1 },
    });
    res.status(201).json(shapeClause(row));
  })
);

crmQuoteRouter.post(
  "/crmQuoteClause/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const { id, ...b } = req.body as ClauseBody & { id: string };
    if (!id) throw new HttpError(400, "id requis");
    if (b.label !== undefined && !b.label.trim()) throw new HttpError(400, "Le libellé ne peut pas être vide");
    if (b.text !== undefined && !b.text.trim()) throw new HttpError(400, "Le texte ne peut pas être vide");
    const existing = await prisma.crmQuoteClause.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Clause introuvable");
    const row = await prisma.crmQuoteClause.update({
      where: { id },
      data: { label: b.label?.trim(), text: b.text?.trim() },
    });
    res.json(shapeClause(row));
  })
);

crmQuoteRouter.post(
  "/crmQuoteClause/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmQuoteClause.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Clause introuvable");
    await prisma.crmQuoteClause.delete({ where: { id } });
    res.json({ ok: true });
  })
);

/** POST /wa/crmQuoteClause/reorder — body: {orderedIds:[...]}. */
crmQuoteRouter.post(
  "/crmQuoteClause/reorder",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const orderedIds = Array.isArray(req.body.orderedIds) ? (req.body.orderedIds as string[]) : [];
    const owned = await prisma.crmQuoteClause.findMany({ select: { id: true } });
    const ownedIds = new Set(owned.map((c) => c.id));
    if (orderedIds.length !== ownedIds.size || orderedIds.some((id) => !ownedIds.has(id))) {
      throw new HttpError(400, "Liste d'ordre invalide");
    }
    await prisma.$transaction(orderedIds.map((id, order) => prisma.crmQuoteClause.update({ where: { id }, data: { order } })));
    res.json({ ok: true });
  })
);

// ── Bibliothèque documentaire (29/10/2026) — documents gérés à part (pas
// insérés automatiquement dans le devis), choisis au cas par cas pour être
// joints à l'envoi d'un devis précis (cf. CrmQuote.attachedDocumentIds,
// POST /crmQuote/sendEmail ci-dessous). Liste renvoyée SANS le contenu
// base64 (lourd, inutile pour l'affichage/la sélection côté client) — cf.
// /crmDocument/get pour le contenu complet d'un document précis.
function shapeDocumentMeta(d: {
  id: string;
  title: string;
  description: string | null;
  fileName: string | null;
  fileMimeType: string | null;
  url: string | null;
  secteurs: string[];
  active: boolean;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: d.id,
    title: d.title,
    description: d.description || "",
    fileName: d.fileName,
    fileMimeType: d.fileMimeType,
    url: d.url,
    secteurs: d.secteurs,
    active: d.active,
    order: d.order,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

crmQuoteRouter.get(
  "/crmDocument/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.crmDocument.findMany({
      orderBy: { order: "asc" },
      select: { id: true, title: true, description: true, fileName: true, fileMimeType: true, url: true, secteurs: true, active: true, order: true, createdAt: true, updatedAt: true },
    });
    res.json(rows.map(shapeDocumentMeta));
  })
);

interface DocumentCreateBody {
  title: string;
  description?: string;
  fileName?: string;
  fileMimeType?: string;
  fileContentBase64?: string; // data URL complète ou base64 nu, nettoyé ci-dessous
  url?: string;
  secteurs?: string[];
}

crmQuoteRouter.post(
  "/crmDocument/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as DocumentCreateBody;
    if (!b.title || !b.title.trim()) throw new HttpError(400, "Titre requis");
    const raw = (b.fileContentBase64 || "").trim();
    const url = (b.url || "").trim();
    if (!raw && !url) throw new HttpError(400, "Fichier ou lien URL requis");
    if (raw && url) throw new HttpError(400, "Choisissez soit un fichier, soit un lien URL, pas les deux");
    const agg = await prisma.crmDocument.aggregate({ _max: { order: true } });
    const row = await prisma.crmDocument.create({
      data: raw
        ? {
            title: b.title.trim(),
            description: b.description?.trim() || undefined,
            fileName: b.fileName || b.title.trim(),
            fileMimeType: b.fileMimeType || "application/octet-stream",
            fileContentBase64: raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw,
            secteurs: Array.isArray(b.secteurs) ? b.secteurs : [],
            order: (agg._max.order ?? -1) + 1,
          }
        : {
            title: b.title.trim(),
            description: b.description?.trim() || undefined,
            url,
            secteurs: Array.isArray(b.secteurs) ? b.secteurs : [],
            order: (agg._max.order ?? -1) + 1,
          },
    });
    res.status(201).json(shapeDocumentMeta(row));
  })
);

interface DocumentUpdateBody {
  id: string;
  title?: string;
  description?: string;
  secteurs?: string[];
  active?: boolean;
  order?: number;
}

crmQuoteRouter.post(
  "/crmDocument/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as DocumentUpdateBody;
    if (!b.id) throw new HttpError(400, "id requis");
    if (b.title !== undefined && !b.title.trim()) throw new HttpError(400, "Le titre ne peut pas être vide");
    const existing = await prisma.crmDocument.findUnique({ where: { id: b.id } });
    if (!existing) throw new HttpError(404, "Document introuvable");
    const row = await prisma.crmDocument.update({
      where: { id: b.id },
      data: {
        title: b.title?.trim(),
        description: b.description === undefined ? undefined : b.description.trim() || null,
        secteurs: Array.isArray(b.secteurs) ? b.secteurs : undefined,
        active: typeof b.active === "boolean" ? b.active : undefined,
        order: typeof b.order === "number" ? b.order : undefined,
      },
    });
    res.json(shapeDocumentMeta(row));
  })
);

crmQuoteRouter.post(
  "/crmDocument/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmDocument.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Document introuvable");
    await prisma.crmDocument.delete({ where: { id } });
    res.json({ ok: true });
  })
);

// ── Signature électronique simple ──
// Volontairement pas une signature électronique qualifiée (eIDAS) — capture
// nom saisi + tracé (canvas) + horodatage/IP/user-agent à titre de preuve
// de consentement, à la manière d'un "clic pour accepter" plutôt qu'une
// signature certifiée par un tiers de confiance (Yousign/DocuSign...). Le
// front-end doit afficher cette nuance clairement au signataire.

function quoteTotals(lines: QuoteLine[], discountPct: number, vatPct: number, depositPct: number) {
  let mrr = 0;
  let oneoff = 0;
  let hasUnpriced = false;
  for (const l of lines) {
    if (l.unitPrice === null || l.unitPrice === undefined) {
      hasUnpriced = true;
      continue;
    }
    const t = (l.qty || 0) * l.unitPrice;
    if (l.recurring) mrr += t;
    else oneoff += t;
  }
  const factor = 1 - (discountPct || 0) / 100;
  const mrrNet = mrr * factor;
  const oneoffNet = oneoff * factor;
  const totalHT = mrrNet + oneoffNet;
  const totalTTC = totalHT * (1 + (vatPct || 0) / 100);
  const depositAmount = totalTTC * ((depositPct || 0) / 100);
  return { mrr, oneoff, mrrNet, oneoffNet, totalHT, totalTTC, depositAmount, hasUnpriced };
}

/**
 * POST /wa/crmQuote/requestSignature — génère (ou réutilise) le token
 * d'accès à la page publique de signature et marque le devis "envoyé".
 */
crmQuoteRouter.post(
  "/crmQuote/requestSignature",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmQuote.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Devis introuvable");
    if (existing.status === "accepté") throw new HttpError(400, "Ce devis est déjà signé");
    const signToken = existing.signToken || crypto.randomBytes(24).toString("hex");
    const row = await prisma.crmQuote.update({
      where: { id },
      data: {
        signToken,
        status: existing.status === "brouillon" ? "envoyé" : undefined,
        sentAt: existing.sentAt ?? new Date(),
      },
      include: QUOTE_INCLUDE,
    });
    res.json(shapeQuote(row));
  })
);

/**
 * GET /wa/crmQuote/public?token=... — lecture seule, sans authentification
 * (le signataire n'a pas de compte CRM). N'expose que le nécessaire pour
 * afficher le devis à signer.
 */
crmQuoteRouter.get(
  "/crmQuote/public",
  asyncHandler(async (req, res) => {
    const token = (req.query.token as string) || "";
    if (!token) throw new HttpError(400, "Lien invalide");
    const quote = await prisma.crmQuote.findUnique({
      where: { signToken: token },
      include: { prospect: { select: { nom: true, commercial: { select: { name: true, bookingUrl: true } } } }, signature: true },
    });
    if (!quote) throw new HttpError(404, "Lien de signature invalide ou expiré");
    const storedLines = (quote.lines as unknown as QuoteLine[]) || [];
    const config = (quote.config as QuoteConfig) || {};
    const hardwareLines = storedLines.filter((l) => l.category === "materiel" && l.group !== "accessory");
    const lines = expandQuoteLines(storedLines, hardwareLines, config);

    // Document/lien rattaché au PRODUIT d'origine d'une ligne Équipements/
    // Accessoires (30/10/2026, demande client "sur chaque produit pouvoir
    // rattacher un document ou une url qui pourra s'afficher sur le
    // devis") — cf. CrmProduct.documentId, résolu ici une fois pour toutes
    // les lignes plutôt qu'une requête par ligne.
    const productIds = [...new Set(lines.map((l) => l.productId).filter((id): id is string => !!id))];
    const productDocsById = productIds.length
      ? new Map(
          (
            await prisma.crmProduct.findMany({
              where: { id: { in: productIds }, documentId: { not: null } },
              select: { id: true, document: { select: { id: true, title: true, fileMimeType: true, url: true } } },
            })
          )
            .filter((p) => p.document && (p.document.url || p.document.fileMimeType))
            .map((p) => [p.id, p.document!] as const)
        )
      : new Map();
    const linesWithDocs = lines.map((l) => ({ ...l, productDocument: l.productId ? productDocsById.get(l.productId) || null : null }));

    // Espace client (29/10/2026, demande "créer un vrai espace client à
    // onglets") : en plus du devis, on expose les documents de la
    // bibliothèque attachés à CE devis (sans le contenu base64, cf. routes
    // de téléchargement dédiées ci-dessous) et les réunions Teams choisies
    // pour CE devis (30/10/2026, "en option" — cf. attachedMeetingIds,
    // onglet Document du constructeur) — plus d'exposition automatique de
    // toutes les réunions du prospect, le commercial choisit lesquelles
    // montrer au client.
    const [documents, meetings] = await Promise.all([
      quote.attachedDocumentIds.length
        ? prisma.crmDocument.findMany({
            where: { id: { in: quote.attachedDocumentIds }, active: true },
            select: { id: true, title: true, description: true, fileName: true, fileMimeType: true, url: true },
            orderBy: { order: "asc" },
          })
        : Promise.resolve([]),
      quote.attachedMeetingIds.length
        ? prisma.crmMeeting.findMany({
            where: { id: { in: quote.attachedMeetingIds }, prospectId: quote.prospectId },
            select: { id: true, subject: true, startDateTime: true, summaryText: true, recordingGraphId: true },
            orderBy: { startDateTime: "desc" },
          })
        : Promise.resolve([]),
    ]);

    res.json({
      number: quote.number,
      title: quote.title,
      status: quote.status,
      lines: linesWithDocs,
      discountPct: quote.discountPct,
      vatPct: quote.vatPct,
      depositPct: quote.depositPct,
      introText: quote.introText || "",
      mentionsText: quote.mentionsText || "",
      termsText: quote.termsText || "",
      totals: quoteTotals(lines, quote.discountPct, quote.vatPct, quote.depositPct),
      prospectNom: quote.prospect.nom,
      // Prise de RDV filtrée sur le commercial en charge du dossier
      // (30/10/2026) — lien personnel s'il en a un de renseigné (cf.
      // AdminUser.bookingUrl), repli sur null = lien générique côté front.
      commercialName: quote.prospect.commercial?.name || "",
      commercialBookingUrl: quote.prospect.commercial?.bookingUrl || null,
      alreadySigned: !!quote.signature,
      signedAt: quote.signature?.signedAt || null,
      signerName: quote.signature?.signerName || null,
      documents,
      // Résumé et lien vidéo = deux options indépendantes À L'INTÉRIEUR
      // d'une réunion déjà attachée (30/10/2026, "mettre le lien de la
      // vidéo et/ou le résumé") — null/false quand non cochés, pour que
      // l'affichage côté espace client (déjà conditionné sur ces champs)
      // n'ait rien de plus à savoir.
      meetings: meetings.map((m) => ({
        id: m.id,
        subject: m.subject,
        startDateTime: m.startDateTime,
        summaryText: quote.attachedMeetingSummaryIds.includes(m.id) ? m.summaryText : null,
        hasRecording: quote.attachedMeetingVideoIds.includes(m.id) && !!m.recordingGraphId,
      })),
    });
  })
);

const QUOTE_TRACK_EVENT_TYPES = new Set<ScoreEventType>(["quote_tab_viewed", "quote_document_opened"]);

/**
 * POST /wa/crmQuote/trackEvent?token=... — sans authentification admin (le
 * visiteur de l'espace client n'a pas de session CRM), sécurisé par le seul
 * fait de connaître un signToken valide (même modèle que les autres routes
 * publicXxx ci-dessus). Alimente le score d'intérêt (30/10/2026, demande
 * client "tracking des onglets et documents ouverts... ajuster le score
 * d'intérêt") — deux types seulement, volontairement fermés : impossible
 * d'injecter un autre type de score depuis le navigateur du visiteur.
 */
crmQuoteRouter.post(
  "/crmQuote/trackEvent",
  asyncHandler(async (req, res) => {
    const token = (req.body.token as string) || "";
    const eventType = req.body.eventType as string;
    const module = (req.body.module as string) || undefined;
    if (!token) throw new HttpError(400, "Lien invalide");
    if (!QUOTE_TRACK_EVENT_TYPES.has(eventType as ScoreEventType)) throw new HttpError(400, "eventType invalide");
    const quote = await prisma.crmQuote.findUnique({ where: { signToken: token }, select: { prospectId: true } });
    if (!quote) {
      res.json({ ok: true, matched: false });
      return;
    }
    await recordScoreEvent(quote.prospectId, eventType as ScoreEventType, module, "internal");
    res.json({ ok: true, matched: true });
  })
);

/**
 * GET /wa/crmQuote/publicDocument/:docId?token=... — téléchargement d'un
 * document de la bibliothèque, depuis l'espace client public (même jeton
 * que /crmQuote/public). Vérifie que docId fait bien partie des documents
 * attachés à CE devis précis — jamais un accès libre à toute la
 * bibliothèque via un id devinable.
 */
crmQuoteRouter.get(
  "/crmQuote/publicDocument/:docId",
  asyncHandler(async (req, res) => {
    const token = (req.query.token as string) || "";
    if (!token) throw new HttpError(400, "Lien invalide");
    const quote = await prisma.crmQuote.findUnique({ where: { signToken: token }, select: { attachedDocumentIds: true, lines: true } });
    if (!quote) throw new HttpError(404, "Document introuvable");
    let authorized = quote.attachedDocumentIds.includes(req.params.docId);
    if (!authorized) {
      // Document rattaché à un PRODUIT d'une ligne du devis (cf.
      // CrmProduct.documentId) plutôt qu'à la liste attachedDocumentIds —
      // même garde-fou, juste une seconde source d'autorisation possible.
      const productIds = [...new Set(((quote.lines as unknown as QuoteLine[]) || []).map((l) => l.productId).filter((id): id is string => !!id))];
      if (productIds.length) {
        const match = await prisma.crmProduct.findFirst({ where: { id: { in: productIds }, documentId: req.params.docId } });
        authorized = !!match;
      }
    }
    if (!authorized) throw new HttpError(404, "Document introuvable");
    const doc = await prisma.crmDocument.findUnique({ where: { id: req.params.docId } });
    if (!doc || !doc.active) throw new HttpError(404, "Document introuvable");
    // Document "lien URL" (cf. CrmDocument.url) — pas de contenu binaire en
    // base, on redirige simplement vers la source externe.
    if (doc.url) {
      res.redirect(302, doc.url);
      return;
    }
    if (!doc.fileContentBase64 || !doc.fileMimeType || !doc.fileName) throw new HttpError(404, "Document introuvable");
    res.setHeader("Content-Type", doc.fileMimeType);
    res.setHeader("Content-Disposition", `inline; filename="${doc.fileName.replace(/"/g, "")}"`);
    res.send(Buffer.from(doc.fileContentBase64, "base64"));
  })
);

/**
 * GET /wa/crmQuote/publicRecording/:meetingId?token=... — proxy du flux
 * vidéo d'un enregistrement Teams, depuis l'espace client public. Vérifie
 * que la réunion appartient bien au MÊME prospect que ce devis (même
 * garde-fou que publicDocument ci-dessus).
 */
crmQuoteRouter.get(
  "/crmQuote/publicRecording/:meetingId",
  asyncHandler(async (req, res) => {
    const token = (req.query.token as string) || "";
    if (!token) throw new HttpError(400, "Lien invalide");
    const quote = await prisma.crmQuote.findUnique({ where: { signToken: token }, select: { prospectId: true } });
    if (!quote) throw new HttpError(404, "Lien invalide");
    const row = await prisma.crmMeeting.findUnique({ where: { id: req.params.meetingId } });
    if (!row || row.prospectId !== quote.prospectId || !row.recordingGraphId) throw new HttpError(404, "Aucun enregistrement disponible");
    const upstream = await getRecordingStream(row.graphOrganizerUserId, row.graphMeetingId, row.recordingGraphId);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp4");
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (!upstream.body) {
      res.status(502).end();
      return;
    }
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      res.end();
    }
  })
);

/**
 * POST /wa/crmQuote/sendEmail — envoie réellement le devis par email au
 * client : génère le lien de signature si besoin (même logique que
 * requestSignature) puis passe par le point de convergence unique
 * sendMessage() (lib/messaging.ts), avec le modèle email de catégorie
 * "devis" (clé "devis-envoi") — modèle à créer une fois dans Messages >
 * Modèles si absent, comme tout autre modèle du CRM (pas de contenu codé en
 * dur ici, pour rester cohérent avec le reste du CRM).
 */
crmQuoteRouter.post(
  "/crmQuote/sendEmail",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmQuote.findUnique({
      where: { id },
      include: { prospect: { select: { id: true, nom: true, email: true, commercial: { select: { name: true, email: true } } } } },
    });
    if (!existing) throw new HttpError(404, "Devis introuvable");
    if (existing.status === "accepté") throw new HttpError(400, "Ce devis est déjà signé");
    const prospect = existing.prospect;
    // Transmission à un signataire précis (30/10/2026, demande client) —
    // le contact qui doit réellement signer n'est pas toujours l'email
    // générique de la fiche prospect (ex. un décideur distinct). Repli sur
    // prospect.email si aucun override fourni, comportement inchangé.
    const overrideEmail = (req.body.toEmail as string | undefined)?.trim();
    const overrideName = (req.body.toName as string | undefined)?.trim();
    const toEmail = overrideEmail || prospect.email;
    const toName = overrideName || prospect.nom;
    if (!toEmail) throw new HttpError(400, "Le client n'a pas d'adresse email enregistrée");

    const signToken = existing.signToken || crypto.randomBytes(24).toString("hex");
    const storedLines = (existing.lines as unknown as QuoteLine[]) || [];
    const config = (existing.config as QuoteConfig) || {};
    const hardwareLines = storedLines.filter((l) => l.category === "materiel" && l.group !== "accessory");
    const lines = expandQuoteLines(storedLines, hardwareLines, config);
    const totals = quoteTotals(lines, existing.discountPct, existing.vatPct, existing.depositPct);
    const signUrl = `${req.protocol}://${req.get("host")}/devis-signature.html?token=${signToken}`;

    // Signature humaine de l'email — commercial assigné au prospect si
    // renseigné (CrmProspect.commercial), sinon repli sur l'adresse support
    // CRM générique (SmtpConfig.supportFromEmail, portée globale) plutôt que
    // de laisser un {{commercialNom}}/{{commercialEmail}} vide dans le
    // corps du modèle (29/10/2026, modèle email fourni par le client).
    let commercialNom = prospect.commercial?.name || "";
    let commercialEmail = prospect.commercial?.email || "";
    if (!commercialNom || !commercialEmail) {
      const smtp = await getSmtpConfig(null);
      commercialNom = commercialNom || "L'équipe Sesame Technology";
      commercialEmail = commercialEmail || smtp?.supportFromEmail || smtp?.fromEmail || "";
    }

    // Documents de la bibliothèque choisis pour cet envoi (cf.
    // attachedDocumentIds) — un id devenu introuvable (document supprimé
    // depuis) est silencieusement ignoré plutôt que de bloquer l'envoi du
    // devis pour une pièce jointe non essentielle.
    const extraAttachments = existing.attachedDocumentIds.length
      ? (
          await prisma.crmDocument.findMany({
            where: { id: { in: existing.attachedDocumentIds } },
            select: { fileName: true, fileMimeType: true, fileContentBase64: true },
          })
        )
          // Un document "lien URL" (cf. CrmDocument.url) n'a pas de contenu
          // binaire à joindre à l'email — il reste consultable via l'onglet
          // Documents de l'espace client, simplement pas en pièce jointe ici.
          .filter((d) => d.fileContentBase64)
          .map((d) => ({ fileName: d.fileName!, dataUrl: `data:${d.fileMimeType};base64,${d.fileContentBase64}` }))
      : [];

    try {
      await sendMessage({
        entityId: null,
        channel: "email",
        templateKey: "devis-envoi",
        to: toEmail,
        trackOpenProspectId: prospect.id,
        extraAttachments,
        variables: {
          numeroDevis: existing.number,
          nomClient: toName,
          montantInitial: totals.oneoffNet.toFixed(2).replace(".", ",") + " €",
          montantMensuel: totals.mrrNet.toFixed(2).replace(".", ",") + " €",
          montantTotalTTC: totals.totalTTC.toFixed(2).replace(".", ",") + " €",
          lienSignature: signUrl,
          commercialNom,
          commercialEmail,
        },
      });
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        throw new HttpError(404, 'Aucun modèle email "devis-envoi" (catégorie Devis) — créez-le dans Messages > Modèles avant d\'envoyer.');
      }
      throw e;
    }

    const row = await prisma.crmQuote.update({
      where: { id },
      data: {
        signToken,
        status: existing.status === "brouillon" ? "envoyé" : undefined,
        sentAt: existing.sentAt ?? new Date(),
      },
      include: QUOTE_INCLUDE,
    });
    res.json(shapeQuote(row));
  })
);

interface SignBody {
  token: string;
  signerName: string;
  signerEmail?: string;
  signatureDataUrl: string;
  consent: boolean;
}

/**
 * POST /wa/crmQuote/sign — enregistre la signature et fait passer
 * automatiquement le statut du devis à "accepté" (et l'affaire à "Gagné"
 * SI le devis est rattaché à une affaire — plus systématique depuis que le
 * rattachement est optionnel, 22/10/2026).
 */
crmQuoteRouter.post(
  "/crmQuote/sign",
  asyncHandler(async (req, res) => {
    const b = req.body as SignBody;
    if (!b.token) throw new HttpError(400, "Lien invalide");
    if (!b.consent) throw new HttpError(400, "Le consentement est requis pour signer");
    if (!b.signerName || !b.signerName.trim()) throw new HttpError(400, "Nom du signataire requis");
    if (!b.signatureDataUrl) throw new HttpError(400, "Signature requise");

    const quote = await prisma.crmQuote.findUnique({ where: { signToken: b.token }, include: { signature: true } });
    if (!quote) throw new HttpError(404, "Lien de signature invalide ou expiré");
    if (quote.signature) throw new HttpError(400, "Ce devis a déjà été signé");

    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || undefined;

    await prisma.$transaction([
      prisma.crmQuoteSignature.create({
        data: {
          quoteId: quote.id,
          signerName: b.signerName.trim(),
          signerEmail: b.signerEmail?.trim() || undefined,
          signatureDataUrl: b.signatureDataUrl,
          ip,
          userAgent: req.headers["user-agent"] || undefined,
        },
      }),
      prisma.crmQuote.update({ where: { id: quote.id }, data: { status: "accepté" } }),
      ...(quote.dealId ? [prisma.crmDeal.update({ where: { id: quote.dealId }, data: { stage: "Gagné" } })] : []),
    ]);

    res.json({ ok: true });
  })
);
