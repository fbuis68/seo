import { prisma } from "../db";
import { AccSupplier } from "@prisma/client";

/**
 * Rapprochement fournisseur (§15) — ordre de priorité fixé par le cahier
 * des charges : SIRET > TVA > SIREN > IBAN > raison sociale > adresse >
 * email. S'arrête au premier critère qui matche (un SIRET rapproché est
 * plus fiable qu'un nom approché, jamais l'inverse).
 */
export interface SupplierMatchResult {
  supplier: AccSupplier | null;
  confidence: number;
  matchedBy: string | null;
}

function normalizeCompanyName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // accents
    .toLowerCase()
    .replace(/\b(sas|sarl|sa|sasu|eurl|sci|ei|snc)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function matchSupplier(
  entityId: string | null,
  extracted: { issuerSiret?: string | null; issuerSiren?: string | null; issuerVat?: string | null; issuerIban?: string | null; issuerName?: string | null }
): Promise<SupplierMatchResult> {
  if (extracted.issuerSiret) {
    const s = await prisma.accSupplier.findFirst({ where: { entityId, siret: extracted.issuerSiret } });
    if (s) return { supplier: s, confidence: 0.98, matchedBy: "siret" };
  }
  if (extracted.issuerVat) {
    const s = await prisma.accSupplier.findFirst({ where: { entityId, vatNumber: extracted.issuerVat } });
    if (s) return { supplier: s, confidence: 0.95, matchedBy: "vat" };
  }
  if (extracted.issuerSiren) {
    const s = await prisma.accSupplier.findFirst({ where: { entityId, siren: extracted.issuerSiren } });
    if (s) return { supplier: s, confidence: 0.9, matchedBy: "siren" };
  }
  if (extracted.issuerIban) {
    const s = await prisma.accSupplier.findFirst({ where: { entityId, iban: extracted.issuerIban } });
    if (s) return { supplier: s, confidence: 0.85, matchedBy: "iban" };
  }
  if (extracted.issuerName) {
    // Comparaison sur nom normalisé (accents/forme juridique/casse retirés)
    // — jamais de correspondance floue plus agressive (distance de
    // Levenshtein, etc.) à ce stade : un faux rapprochement par nom
    // affecterait une facture au mauvais fournisseur silencieusement,
    // pire qu'un rapprochement manqué (qui, lui, reste visible et
    // proposable à la création — cf. proposeSupplierFromExtraction).
    const target = normalizeCompanyName(extracted.issuerName);
    if (target) {
      const candidates = await prisma.accSupplier.findMany({ where: { entityId } });
      const match = candidates.find((c) => normalizeCompanyName(c.name) === target);
      if (match) return { supplier: match, confidence: 0.6, matchedBy: "name" };
    }
  }
  return { supplier: null, confidence: 0, matchedBy: null };
}

/**
 * Construit une fiche fournisseur à partir des champs extraits — utilisé
 * quand matchSupplier() n'a rien trouvé. N'est PAS appelé automatiquement
 * partout : la création automatique n'a lieu que si un identifiant fort
 * (SIRET/SIREN/TVA) est disponible (cf. routes/accounting.ts), sinon la
 * proposition reste affichée à l'utilisateur sans fiche créée — un nom
 * seul, mal extrait, ne doit pas polluer la base fournisseurs.
 */
export function canAutoCreateSupplier(extracted: { issuerSiret?: string | null; issuerSiren?: string | null; issuerVat?: string | null; issuerName?: string | null }): boolean {
  return !!(extracted.issuerName && (extracted.issuerSiret || extracted.issuerSiren || extracted.issuerVat));
}

export async function createSupplierFromExtraction(
  entityId: string | null,
  extracted: { issuerName?: string | null; issuerSiren?: string | null; issuerSiret?: string | null; issuerVat?: string | null; issuerIban?: string | null; issuerBic?: string | null }
): Promise<AccSupplier> {
  return prisma.accSupplier.create({
    data: {
      entityId,
      name: extracted.issuerName || "Fournisseur sans nom",
      siren: extracted.issuerSiren || undefined,
      siret: extracted.issuerSiret || undefined,
      vatNumber: extracted.issuerVat || undefined,
      iban: extracted.issuerIban || undefined,
      bic: extracted.issuerBic || undefined,
    },
  });
}
