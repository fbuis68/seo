import { prisma } from "../db";

/**
 * Sous-ensemble courant du Plan Comptable Général français — volontairement
 * PAS exhaustif (le PCG complet compte plusieurs centaines de comptes) :
 * de quoi faire fonctionner le pipeline achat/vente/banque de bout en bout
 * dès l'installation, complétable ensuite par import/création (§16 du
 * cahier des charges — jamais codé en dur dans le moteur de règles
 * lui-même, cf. lib/accRulesEngine.ts, qui ne connaît que des ids de
 * AccAccount).
 */
export const PCG_COMMON: { number: string; label: string; type: string }[] = [
  { number: "401000", label: "Fournisseurs", type: "tiers" },
  { number: "411000", label: "Clients", type: "tiers" },
  { number: "445200", label: "TVA due intracommunautaire (autoliquidation)", type: "tva" },
  { number: "445620", label: "TVA déductible sur immobilisations", type: "tva" },
  { number: "445660", label: "TVA déductible sur autres biens et services", type: "tva" },
  { number: "445710", label: "TVA collectée", type: "tva" },
  { number: "445830", label: "TVA à régulariser (autoliquidation intracommunautaire)", type: "tva" },
  { number: "512000", label: "Banque", type: "banque" },
  { number: "530000", label: "Caisse", type: "banque" },
  { number: "606100", label: "Fournitures non stockables (eau, énergie)", type: "charge" },
  { number: "606300", label: "Fournitures d'entretien et de petit équipement", type: "charge" },
  { number: "606400", label: "Fournitures administratives", type: "charge" },
  { number: "606800", label: "Autres matières et fournitures", type: "charge" },
  { number: "607000", label: "Achats de marchandises", type: "charge" },
  { number: "613000", label: "Locations", type: "charge" },
  { number: "615000", label: "Entretien et réparations", type: "charge" },
  { number: "616000", label: "Primes d'assurances", type: "charge" },
  { number: "618100", label: "Documentation générale", type: "charge" },
  { number: "621000", label: "Personnel extérieur à l'entreprise", type: "charge" },
  { number: "622600", label: "Honoraires", type: "charge" },
  { number: "623000", label: "Publicité, publications, relations publiques", type: "charge" },
  { number: "625100", label: "Voyages et déplacements", type: "charge" },
  { number: "625600", label: "Missions", type: "charge" },
  { number: "626000", label: "Frais postaux et de télécommunications", type: "charge" },
  { number: "627000", label: "Services bancaires et assimilés", type: "charge" },
  { number: "635100", label: "Impôts, taxes et versements assimilés", type: "charge" },
  { number: "641000", label: "Rémunérations du personnel", type: "charge" },
  { number: "645000", label: "Charges de sécurité sociale et de prévoyance", type: "charge" },
  { number: "706000", label: "Prestations de services", type: "produit" },
  { number: "707000", label: "Ventes de marchandises", type: "produit" },
  { number: "708500", label: "Ports et frais accessoires facturés", type: "produit" },
  { number: "758000", label: "Produits divers de gestion courante", type: "produit" },
];

export const JOURNALS_COMMON: { code: string; label: string; type: string }[] = [
  { code: "ACH", label: "Achats", type: "achats" },
  { code: "VEN", label: "Ventes", type: "ventes" },
  { code: "BQ", label: "Banque", type: "banque" },
  { code: "OD", label: "Opérations diverses", type: "od" },
];

/**
 * Idempotent — n'insère que les comptes/journaux absents (comparaison par
 * numéro/code), pour pouvoir être rappelé sans risque après une première
 * initialisation (ex : bouton "Réinitialiser le plan comptable standard").
 */
export async function seedAccounting(entityId: string | null): Promise<{ accountsCreated: number; journalsCreated: number }> {
  const existingAccounts = await prisma.accAccount.findMany({ where: { entityId }, select: { number: true } });
  const existingNumbers = new Set(existingAccounts.map((a) => a.number));
  const toCreateAccounts = PCG_COMMON.filter((a) => !existingNumbers.has(a.number));
  if (toCreateAccounts.length) {
    await prisma.accAccount.createMany({
      data: toCreateAccounts.map((a) => ({ entityId, number: a.number, label: a.label, type: a.type, class: Number(a.number[0]) })),
    });
  }

  const existingJournals = await prisma.accJournal.findMany({ where: { entityId }, select: { code: true } });
  const existingCodes = new Set(existingJournals.map((j) => j.code));
  const toCreateJournals = JOURNALS_COMMON.filter((j) => !existingCodes.has(j.code));
  if (toCreateJournals.length) {
    await prisma.accJournal.createMany({ data: toCreateJournals.map((j) => ({ entityId, code: j.code, label: j.label, type: j.type })) });
  }

  return { accountsCreated: toCreateAccounts.length, journalsCreated: toCreateJournals.length };
}

/** Compte par numéro exact — utilitaire partagé par les autres services du module. */
export async function findAccountByNumber(entityId: string | null, number: string) {
  return prisma.accAccount.findFirst({ where: { entityId, number } });
}
