import { prisma } from "../db";
import { config } from "../config";
import { huntMarket, MarketHunterCandidate } from "./aiClaude";
import { lookupEntrepriseByName } from "./entrepriseApi";

/**
 * Agent "Market Hunter" — orchestration (cahier des charges Sesame AI
 * Autonomous Prospecting, 30/10/2026, backlog P1). huntMarket() (lib/
 * aiClaude.ts) ne fait QUE la recherche web ; tout le reste (déduplication,
 * enrichissement SIREN, notation, création CRM) vit ici, séparé de l'appel
 * LLM par principe (§2 "séparer moteur IA du moteur d'exécution" du
 * cahier des charges — aucun appel LLM n'écrit directement en CRM).
 */

export const MARCHES = ["hotel", "padel", "residence"] as const;
export type Marche = (typeof MARCHES)[number];

export const MARCHE_DEFS: Record<Marche, { label: string; secteur: string; icp: string }> = {
  hotel: {
    label: "Hôtellerie",
    secteur: "Hôtellerie",
    icp: "Hôtels indépendants ou petits groupes de 20 à 300 chambres en France, avec un signal récent d'ouverture, de rénovation ou de passage à un accueil autonome (sans réception 24h/24).",
  },
  padel: {
    label: "Padel / sport",
    secteur: "Padel",
    icp: "Clubs de padel (ou complexes multi-sports avec terrains de padel) en France, nouvellement ouverts ou en projet d'ouverture, avec un besoin probable d'accès autonome aux terrains (hors horaires de présence humaine).",
  },
  residence: {
    label: "Résidence",
    secteur: "Résidence",
    icp: "Gestionnaires de résidences étudiantes, coliving ou résidences services en France, gérant plusieurs sites, avec un signal récent d'ouverture ou d'extension de parc.",
  },
};

function normalizeCompanyName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseDate(raw: string | null): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * P1-09 — exclut les doublons (fiche CRM déjà existante, quel que soit son
 * type) et les entreprises en liste d'exclusion (P0-09). Comparaison par
 * SIREN quand connu, sinon par nom normalisé (accents/casse/espaces) — une
 * correspondance partielle (l'un contient l'autre) compte comme doublon,
 * un sigle/une raison sociale abrégée étant fréquents d'une source à l'autre.
 */
export async function isDuplicateOrExcluded(name: string, siren: string | null): Promise<boolean> {
  const target = normalizeCompanyName(name);
  const [prospects, suppressions] = await Promise.all([
    prisma.crmProspect.findMany({
      where: siren ? { OR: [{ siren }, { nom: { contains: name.slice(0, 40), mode: "insensitive" } }] } : { nom: { contains: name.slice(0, 40), mode: "insensitive" } },
      select: { nom: true, siren: true },
      take: 20,
    }),
    prisma.suppression.findMany({
      where: siren ? { OR: [{ siren }, { companyName: { contains: name.slice(0, 40), mode: "insensitive" } }] } : { companyName: { contains: name.slice(0, 40), mode: "insensitive" } },
      select: { companyName: true, siren: true },
      take: 20,
    }),
  ]);
  const hit = (rows: { nom?: string; companyName?: string | null; siren?: string | null }[]) =>
    rows.some((r) => {
      if (siren && r.siren && r.siren === siren) return true;
      const candidate = normalizeCompanyName(r.nom || r.companyName || "");
      return candidate.length > 0 && (candidate.includes(target) || target.includes(candidate));
    });
  return hit(prospects) || hit(suppressions);
}

export interface DiscoveryScore {
  marketFit: number;
  recentSignal: number;
  economicPotential: number;
  decisionMakerAccess: number;
  urgency: number;
  technicalFit: number;
  dataReliability: number;
  total: number;
  classification: string;
  justification: Record<string, string>;
}

function sizeScore(tailleHint: string | null, marche: Marche): number {
  if (!tailleHint) return 3;
  const m = tailleHint.match(/(\d+)/);
  if (!m) return 6;
  const n = parseInt(m[1], 10);
  if (marche === "hotel") return n >= 20 && n <= 300 ? 15 : 8;
  return 12;
}

function classify(total: number): string {
  if (total >= 85) return "hot_lead";
  if (total >= 70) return "qualified_lead";
  if (total >= 50) return "nurturing";
  return "low_priority";
}

/**
 * P1-08 — notation déterministe (pas d'appel LLM) : le critère d'acceptation
 * du brief est "score explicable ET REPRODUCTIBLE" — une formule fixe l'est
 * strictement, un appel LLM ne l'est qu'approximativement, et évite un appel
 * Claude supplémentaire par candidat (coût). Mêmes 7 axes/0-100 que le score
 * qualificatif B2B existant (lib/aiClaude.ts computeSalesScore) pour rester
 * cohérent à l'affichage (table SalesScore partagée).
 */
export function computeDiscoveryScore(c: MarketHunterCandidate, marche: Marche, enriched: { siren: string | null; effectifSalarie: string | null }): DiscoveryScore {
  const hasBasicIdentity = !!(c.name && c.ville);
  const marketFit = hasBasicIdentity ? 20 : 10;

  const conf = Math.max(0, Math.min(1, c.confidence || 0));
  let recentSignal = Math.round(conf * 20);
  if (c.signalDate) {
    const days = (Date.now() - new Date(c.signalDate).getTime()) / 86400000;
    if (days >= 0 && days <= 90) recentSignal += 5;
  }
  recentSignal = Math.min(25, recentSignal);

  const economicPotential = sizeScore(c.tailleHint || enriched.effectifSalarie, marche);
  const decisionMakerAccess = c.decisionMakerName ? 10 : c.decisionMakerTitle ? 5 : 0;

  const urgentTypes = new Set(["ouverture", "renovation", "agrandissement"]);
  const urgency = urgentTypes.has(c.signalType) ? (recentSignal >= 15 ? 15 : 10) : c.signalType === "recrutement" ? 8 : 5;

  const technicalFit = 5; // inconnu par construction (aucune donnée PMS/infra à ce stade) — valeur moyenne, jamais surnotée

  let dataReliability = 1;
  if (c.siteWeb) dataReliability += 2;
  if (enriched.siren) dataReliability += 2;
  dataReliability = Math.min(5, dataReliability);

  const total = marketFit + recentSignal + economicPotential + decisionMakerAccess + urgency + technicalFit + dataReliability;

  return {
    marketFit,
    recentSignal,
    economicPotential,
    decisionMakerAccess,
    urgency,
    technicalFit,
    dataReliability,
    total,
    classification: classify(total),
    justification: {
      marketFit: hasBasicIdentity ? `Nom et ville identifiés (${c.ville}).` : "Ville non identifiée — identité incomplète.",
      recentSignal: `Confiance de la source : ${Math.round(conf * 100)}%${c.signalDate ? `, datée du ${c.signalDate}` : ", date inconnue"}.`,
      economicPotential: c.tailleHint ? `Taille indiquée : ${c.tailleHint}.` : "Aucune indication de taille trouvée.",
      decisionMakerAccess: c.decisionMakerName ? `Décideur identifié : ${c.decisionMakerName}${c.decisionMakerTitle ? ` (${c.decisionMakerTitle})` : ""}.` : c.decisionMakerTitle ? `Fonction identifiée (${c.decisionMakerTitle}), nom inconnu.` : "Aucun décideur identifié.",
      urgency: `Type de signal : ${c.signalType}.`,
      technicalFit: "Aucune donnée d'infrastructure/PMS disponible à ce stade — valeur neutre.",
      dataReliability: `Site web ${c.siteWeb ? "trouvé" : "non trouvé"}, SIREN ${enriched.siren ? "résolu" : "non résolu"}.`,
    },
  };
}

export interface HuntMarketResult {
  found: number;
  qualified: number;
  excluded: number;
}

/**
 * P1-01 à P1-10 — un passage complet pour un marché : recherche, dédup,
 * enrichissement, notation, création CRM du prospect qualifié (score >= 70
 * uniquement, cf. définition "prospect qualifié" du brief §1 — en dessous,
 * le candidat est compté dans `excluded` mais jamais stocké individuellement).
 */
export async function huntAndQualifyMarket(marche: Marche, limit: number): Promise<HuntMarketResult> {
  const def = MARCHE_DEFS[marche];
  const [recentProspects, recentSuppressions] = await Promise.all([
    prisma.crmProspect.findMany({ where: { secteur: def.secteur }, select: { nom: true }, orderBy: { createdAt: "desc" }, take: 60 }),
    prisma.suppression.findMany({ select: { companyName: true }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  const excludeNames = [...recentProspects.map((p) => p.nom), ...recentSuppressions.map((s) => s.companyName).filter((x): x is string => !!x)];

  const candidates = await huntMarket({ marcheLabel: def.label, icp: def.icp, excludeNames, limit });

  let qualified = 0;
  let excluded = 0;
  for (const c of candidates) {
    if (await isDuplicateOrExcluded(c.name, null)) {
      excluded++;
      continue;
    }
    const enrichedRaw = await lookupEntrepriseByName(c.name, c.ville || undefined).catch(() => null);
    const enriched = { siren: enrichedRaw?.siren || null, effectifSalarie: enrichedRaw?.effectifSalarie || null };
    if (enriched.siren && (await isDuplicateOrExcluded(c.name, enriched.siren))) {
      excluded++;
      continue;
    }

    const score = computeDiscoveryScore(c, marche, enriched);
    if (score.total < 70) {
      excluded++;
      continue;
    }

    const prospect = await prisma.crmProspect.create({
      data: {
        nom: c.name,
        type: "Prospect",
        secteur: def.secteur,
        origine: "Market Hunter IA",
        denominationSociale: enrichedRaw?.name || null,
        siren: enriched.siren,
        siret: enrichedRaw?.siret || null,
        adresse: enrichedRaw?.addressLine || null,
        ville: enrichedRaw?.city || c.ville || null,
        pays: "France",
        site: c.siteWeb || null,
        effectifSalarie: enriched.effectifSalarie,
      },
      select: { id: true },
    });

    if (c.decisionMakerName) {
      await prisma.crmContact.create({
        data: { prospectId: prospect.id, name: c.decisionMakerName, fonction: c.decisionMakerTitle || null },
      });
    }

    await prisma.salesSignal.create({
      data: {
        prospectId: prospect.id,
        companyName: c.name,
        source: "Recherche web (Agent Market Hunter)",
        url: c.signalUrl,
        signalType: c.signalType,
        publishedAt: parseDate(c.signalDate),
        confidence: c.confidence,
        hypothesis: c.signalSummary,
        status: "to_verify",
      },
    });

    await prisma.salesScore.create({
      data: {
        prospectId: prospect.id,
        marketFit: score.marketFit,
        recentSignal: score.recentSignal,
        economicPotential: score.economicPotential,
        decisionMakerAccess: score.decisionMakerAccess,
        urgency: score.urgency,
        technicalFit: score.technicalFit,
        dataReliability: score.dataReliability,
        total: score.total,
        classification: score.classification,
        justification: score.justification,
      },
    });

    await prisma.agentDecisionLog.create({
      data: {
        agentName: "market_hunter",
        prospectId: prospect.id,
        inputSummary: `Découverte marché ${def.label} : ${c.name}${c.ville ? ` (${c.ville})` : ""}`,
        outputSummary: `Qualifié ${score.total}/100 (${score.classification}) — signal : ${c.signalSummary}`,
        model: config.anthropicModel,
      },
    });

    qualified++;
  }

  return { found: candidates.length, qualified, excluded };
}
