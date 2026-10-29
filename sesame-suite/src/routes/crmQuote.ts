import { Router } from "express";
import crypto from "node:crypto";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { ONBOARDING_MODULES } from "./onboarding";
import { nextSequenceValue } from "../lib/sequence";
import { sendMessage } from "../lib/messaging";

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

// ── Pages d'intro du devis imprimable (29/10/2026) — gestion des pages du
// deck pptx client converties en images (titre/secteurs/ordre/actif), cf.
// printQuote() côté client et le commentaire du modèle CrmQuotePreamblePage.
// Pas de route de création : le jeu de pages initial est seedé une fois
// (prisma/seed.ts) à partir des fichiers statiques déjà déposés dans
// public/quote-preamble/ — seuls titre/secteurs/ordre/actif sont éditables
// ici, pas l'ajout d'un nouveau deck (hors scope de cette demande).
crmQuoteRouter.get(
  "/crmQuotePreamblePage/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.crmQuotePreamblePage.findMany({ orderBy: { order: "asc" } });
    res.json(rows);
  })
);

interface PreamblePageUpdateBody {
  id: string;
  title?: string;
  secteurs?: string[];
  active?: boolean;
  order?: number;
}

crmQuoteRouter.post(
  "/crmQuotePreamblePage/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as PreamblePageUpdateBody;
    if (!b.id) throw new HttpError(400, "id requis");
    if (b.title !== undefined && !b.title.trim()) throw new HttpError(400, "Le titre ne peut pas être vide");
    const existing = await prisma.crmQuotePreamblePage.findUnique({ where: { id: b.id } });
    if (!existing) throw new HttpError(404, "Page introuvable");
    const row = await prisma.crmQuotePreamblePage.update({
      where: { id: b.id },
      data: {
        title: b.title?.trim(),
        secteurs: Array.isArray(b.secteurs) ? b.secteurs : undefined,
        active: typeof b.active === "boolean" ? b.active : undefined,
        order: typeof b.order === "number" ? b.order : undefined,
      },
    });
    res.json(row);
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
      include: { prospect: { select: { nom: true } }, signature: true },
    });
    if (!quote) throw new HttpError(404, "Lien de signature invalide ou expiré");
    const storedLines = (quote.lines as unknown as QuoteLine[]) || [];
    const config = (quote.config as QuoteConfig) || {};
    const hardwareLines = storedLines.filter((l) => l.category === "materiel" && l.group !== "accessory");
    const lines = expandQuoteLines(storedLines, hardwareLines, config);
    res.json({
      number: quote.number,
      title: quote.title,
      status: quote.status,
      lines,
      discountPct: quote.discountPct,
      vatPct: quote.vatPct,
      depositPct: quote.depositPct,
      introText: quote.introText || "",
      mentionsText: quote.mentionsText || "",
      termsText: quote.termsText || "",
      totals: quoteTotals(lines, quote.discountPct, quote.vatPct, quote.depositPct),
      prospectNom: quote.prospect.nom,
      alreadySigned: !!quote.signature,
      signedAt: quote.signature?.signedAt || null,
      signerName: quote.signature?.signerName || null,
    });
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
      include: { prospect: { select: { id: true, nom: true, email: true } } },
    });
    if (!existing) throw new HttpError(404, "Devis introuvable");
    if (existing.status === "accepté") throw new HttpError(400, "Ce devis est déjà signé");
    const prospect = existing.prospect;
    if (!prospect.email) throw new HttpError(400, "Le client n'a pas d'adresse email enregistrée");

    const signToken = existing.signToken || crypto.randomBytes(24).toString("hex");
    const storedLines = (existing.lines as unknown as QuoteLine[]) || [];
    const config = (existing.config as QuoteConfig) || {};
    const hardwareLines = storedLines.filter((l) => l.category === "materiel" && l.group !== "accessory");
    const lines = expandQuoteLines(storedLines, hardwareLines, config);
    const totals = quoteTotals(lines, existing.discountPct, existing.vatPct, existing.depositPct);
    const signUrl = `${req.protocol}://${req.get("host")}/devis-signature.html?token=${signToken}`;

    try {
      await sendMessage({
        entityId: null,
        channel: "email",
        templateKey: "devis-envoi",
        to: prospect.email,
        trackOpenProspectId: prospect.id,
        variables: {
          numeroDevis: existing.number,
          nomClient: prospect.nom,
          montantInitial: totals.oneoffNet.toFixed(2).replace(".", ",") + " €",
          montantMensuel: totals.mrrNet.toFixed(2).replace(".", ",") + " €",
          montantTotalTTC: totals.totalTTC.toFixed(2).replace(".", ",") + " €",
          lienSignature: signUrl,
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
