import { prisma } from "../db";
import { invoiceTotal } from "./accReconciliation";
import { NON_ACCOUNTING_DOC_TYPES } from "./accClassification";

/**
 * Moteur de trésorerie (cahier des charges "Outil de gestion de
 * trésorerie" v1.1, 07/10/2026) — phase 1 ("moteur de solde + calendrier") :
 * solde réalisé par compte à partir d'un ancrage + mouvements bancaires,
 * projection du solde par période (jour/semaine/mois) à partir des
 * échéances de factures fournisseurs/clients déjà en base, retards isolés
 * séparément du flux daté (§6.2 : "Isoler arriérés sans date révisée").
 * Récurrences bancaires qualifiées (phase 2, §4.2 simplifié au mensuel) :
 * intégrées aux projections ci-dessous. Paie, échéancier client découpé en
 * tranches, scénarios/simulations et rapprochement avancé : phases
 * suivantes.
 */

export type Granularity = "day" | "week" | "month";

const UNPAID_STATUSES = ["VALIDATED", "ACCOUNTED", "PARTIALLY_PAID"];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Lundi de la semaine contenant d (ISO, lundi=premier jour). */
function startOfWeek(d: Date): Date {
  const day = d.getDay(); // 0=dimanche..6=samedi
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  return startOfDay(monday);
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addPeriod(d: Date, granularity: Granularity): Date {
  const next = new Date(d);
  if (granularity === "day") next.setDate(next.getDate() + 1);
  else if (granularity === "week") next.setDate(next.getDate() + 7);
  else next.setMonth(next.getMonth() + 1);
  return next;
}

function periodStart(d: Date, granularity: Granularity): Date {
  if (granularity === "day") return startOfDay(d);
  if (granularity === "week") return startOfWeek(d);
  return startOfMonth(d);
}

function addMonths(d: Date, n: number): Date {
  const next = new Date(d);
  next.setMonth(next.getMonth() + n);
  return next;
}

export const RECURRING_FREQUENCIES = ["monthly", "quarterly", "yearly"] as const;
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];

const FREQUENCY_STEP_MONTHS: Record<RecurringFrequency, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

function frequencyStepMonths(frequency: string): number {
  return FREQUENCY_STEP_MONTHS[frequency as RecurringFrequency] || 1;
}

/**
 * Solde réalisé "maintenant" — ancrage + mouvements postérieurs — pour un
 * compte donné, ou agrégé sur tous les comptes de la portée si
 * bankAccountId est omis (hypothèse "plusieurs comptes" du cahier, §1,
 * tous en EUR). Un compte sans ancrage défini part de 0 (signalé via
 * `anchored:false`) plutôt que de resommer tout l'historique, qui peut être
 * incomplet (import partiel, synchronisation récente).
 */
export async function computeBankBalance(entityId: string | null, bankAccountId?: string | null) {
  const accounts = await prisma.accBankAccount.findMany({
    where: { entityId, ...(bankAccountId ? { id: bankAccountId } : {}) },
    select: { id: true, name: true, bank: true, anchorBalance: true, anchorDate: true },
  });
  const result = [];
  let total = 0;
  for (const acc of accounts) {
    const anchored = acc.anchorBalance != null && acc.anchorDate != null;
    const movements = await prisma.accBankTransaction.aggregate({
      where: {
        bankAccountId: acc.id,
        ...(anchored ? { operationDate: { gt: acc.anchorDate! } } : {}),
      },
      _sum: { amount: true },
    });
    const balance = (anchored ? acc.anchorBalance! : 0) + (movements._sum.amount || 0);
    result.push({ id: acc.id, name: acc.name, bank: acc.bank, balance, anchored });
    total += balance;
  }
  return { balance: total, accounts: result };
}

interface TreasuryInvoiceRow {
  dueDate: Date | null;
  amountHt: number | null;
  amountTtc: number | null;
  amountPaid: number | null;
  installments: { amount: number; dueDate: Date | null; paid: boolean }[];
}

function remainingDue(inv: TreasuryInvoiceRow): number {
  return Math.max(0, invoiceTotal(inv) - (inv.amountPaid || 0));
}

/**
 * Entrées de trésorerie d'une facture : une par tranche (découpage de
 * règlement, §AccInvoiceInstallment) si elle en a, sinon une seule entrée
 * pour le solde restant dû de la facture entière — jamais les deux à la
 * fois, sous peine de compter la même créance/dette deux fois (demande
 * client 27/10/2026). Les tranches déjà cochées "payées" n'apparaissent
 * pas ; une tranche sans date ("à déterminer") est traitée comme une
 * facture sans échéance (isolée, pas placée sur le calendrier).
 */
function dueEntries(inv: TreasuryInvoiceRow): { dueDate: Date | null; amount: number }[] {
  if (inv.installments.length) {
    return inv.installments.filter((i) => !i.paid && i.amount > 0.01).map((i) => ({ dueDate: i.dueDate, amount: i.amount }));
  }
  const remaining = remainingDue(inv);
  return remaining > 0.01 ? [{ dueDate: inv.dueDate, amount: remaining }] : [];
}

/**
 * Vue consolidée trésorerie : solde actuel, projection par période sur
 * l'horizon demandé, retards isolés (créances/dettes), plus bas solde
 * projeté. Les échéances déjà dépassées (impayées) ne sont PAS réparties
 * dans les périodes du calendrier — comptées une fois pour toutes dans
 * "retards", conformément au cahier (§6.2) plutôt que de fausser la
 * première période avec un paquet de dates passées.
 */
export async function computeTreasuryOverview(
  entityId: string | null,
  opts: { granularity: Granularity; periods: number; bankAccountId?: string | null }
) {
  const { granularity, periods, bankAccountId } = opts;
  const { balance: currentBalance } = await computeBankBalance(entityId, bankAccountId);

  const today = startOfDay(new Date());
  const horizonStart = periodStart(today, granularity);
  let horizonEnd = horizonStart;
  for (let i = 0; i < periods; i++) horizonEnd = addPeriod(horizonEnd, granularity);

  const [purchaseInvoices, saleInvoices] = await Promise.all([
    prisma.accInvoice.findMany({
      where: {
        entityId,
        direction: "purchase",
        documentType: { notIn: NON_ACCOUNTING_DOC_TYPES },
        status: { in: UNPAID_STATUSES },
      },
      select: { dueDate: true, amountHt: true, amountTtc: true, amountPaid: true, installments: { select: { amount: true, dueDate: true, paid: true } } },
    }),
    prisma.accInvoice.findMany({
      where: {
        entityId,
        direction: "sale",
        documentType: { notIn: NON_ACCOUNTING_DOC_TYPES },
        status: { in: UNPAID_STATUSES },
      },
      select: { dueDate: true, amountHt: true, amountTtc: true, amountPaid: true, installments: { select: { amount: true, dueDate: true, paid: true } } },
    }),
  ]);

  let dettesRetardCount = 0, dettesRetardTotal = 0;
  let creancesRetardCount = 0, creancesRetardTotal = 0;
  // Facture non payée mais sans date d'échéance renseignée (extraction
  // imparfaite, ou champ jamais rempli) : NE DOIT PAS disparaître
  // silencieusement du radar simplement parce qu'elle ne peut pas être
  // placée sur le calendrier (bug constaté 08/10/2026 — "il manque des
  // factures" dans la liste "à venir") — isolée ici comme les retards,
  // plutôt qu'ignorée.
  let dettesSansEcheanceCount = 0, dettesSansEcheanceTotal = 0;
  let creancesSansEcheanceCount = 0, creancesSansEcheanceTotal = 0;
  const futurePurchase: { dueDate: Date; amount: number }[] = [];
  const futureSale: { dueDate: Date; amount: number }[] = [];

  for (const inv of purchaseInvoices) {
    for (const entry of dueEntries(inv)) {
      if (!entry.dueDate) { dettesSansEcheanceCount++; dettesSansEcheanceTotal += entry.amount; continue; }
      if (entry.dueDate < today) { dettesRetardCount++; dettesRetardTotal += entry.amount; }
      else futurePurchase.push({ dueDate: entry.dueDate, amount: entry.amount });
    }
  }
  for (const inv of saleInvoices) {
    for (const entry of dueEntries(inv)) {
      if (!entry.dueDate) { creancesSansEcheanceCount++; creancesSansEcheanceTotal += entry.amount; continue; }
      if (entry.dueDate < today) { creancesRetardCount++; creancesRetardTotal += entry.amount; }
      else futureSale.push({ dueDate: entry.dueDate, amount: entry.amount });
    }
  }

  // Décaissements/encaissements ponctuels hors facturation (12/10/2026,
  // demande client) : lignes saisies à la main (pas de facture/document),
  // fusionnées dans les MÊMES compteurs retard/à-venir que les factures
  // ci-dessus — une ligne manuelle non réglée reste "à venir" même après son
  // échéance, exactement comme une facture non réglée, et en sort dès
  // qu'elle est marquée payée (filtrée ici via paid:false).
  const manualCashflows = await prisma.accManualCashflow.findMany({
    where: { entityId, paid: false },
    select: { direction: true, amount: true, dueDate: true },
  });
  for (const m of manualCashflows) {
    if (m.amount <= 0.01) continue;
    if (m.direction === "DEBIT") {
      if (m.dueDate < today) { dettesRetardCount++; dettesRetardTotal += m.amount; }
      else futurePurchase.push({ dueDate: m.dueDate, amount: m.amount });
    } else {
      if (m.dueDate < today) { creancesRetardCount++; creancesRetardTotal += m.amount; }
      else futureSale.push({ dueDate: m.dueDate, amount: m.amount });
    }
  }

  // Récurrences qualifiées (phase 2, §4.2 — fréquence mensuelle,
  // trimestrielle ou annuelle) : génère les occurrences futures jusqu'à
  // l'horizon demandé et les ajoute aux flux prévus, au même titre que les
  // échéances de factures.
  const recurringRules = await prisma.accRecurringRule.findMany({
    where: { entityId, active: true, ...(bankAccountId ? { bankAccountId } : {}) },
    select: { direction: true, amount: true, nextDate: true, frequency: true },
  });
  for (const rule of recurringRules) {
    const step = frequencyStepMonths(rule.frequency);
    let occ = startOfDay(rule.nextDate);
    // Comparé à AUJOURD'HUI, pas horizonStart (ex: début du mois en cours
    // pour granularity="month") — une occurrence déjà passée CE mois-ci est
    // déjà débitée en pratique et donc déjà reflétée dans currentBalance
    // (computeBankBalance, qui somme les vraies transactions bancaires).
    // La compter encore comme "prévue" ici la soustrairait une seconde fois
    // du solde projeté — double comptage constaté le 21/10/2026 (demande
    // client : "ne pas en tenir compte dans les graphiques deux fois").
    while (occ < today) occ = addMonths(occ, step);
    while (occ < horizonEnd) {
      if (rule.direction === "CREDIT") futureSale.push({ dueDate: occ, amount: rule.amount });
      else futurePurchase.push({ dueDate: occ, amount: rule.amount });
      occ = addMonths(occ, step);
    }
  }

  const buckets: {
    periodStart: Date;
    periodEnd: Date;
    soldeDebut: number;
    encaissementsPrevus: number;
    decaissementsPrevus: number;
    soldeFin: number;
  }[] = [];
  let runningBalance = currentBalance;
  let cursor = horizonStart;
  for (let i = 0; i < periods; i++) {
    const bucketStart = cursor;
    const bucketEnd = addPeriod(cursor, granularity);
    const encaissements = futureSale
      .filter((f) => f.dueDate >= bucketStart && f.dueDate < bucketEnd)
      .reduce((s, f) => s + f.amount, 0);
    const decaissements = futurePurchase
      .filter((f) => f.dueDate >= bucketStart && f.dueDate < bucketEnd)
      .reduce((s, f) => s + f.amount, 0);
    const soldeDebut = runningBalance;
    const soldeFin = soldeDebut + encaissements - decaissements;
    buckets.push({ periodStart: bucketStart, periodEnd: bucketEnd, soldeDebut, encaissementsPrevus: encaissements, decaissementsPrevus: decaissements, soldeFin });
    runningBalance = soldeFin;
    cursor = bucketEnd;
  }

  let plusBasSolde: { amount: number; date: Date } | null = null;
  for (const b of buckets) {
    if (!plusBasSolde || b.soldeFin < plusBasSolde.amount) plusBasSolde = { amount: b.soldeFin, date: b.periodEnd };
  }

  return {
    currentBalance,
    buckets,
    plusBasSolde,
    dettesRetard: { count: dettesRetardCount, total: dettesRetardTotal },
    creancesRetard: { count: creancesRetardCount, total: creancesRetardTotal },
    dettesSansEcheance: { count: dettesSansEcheanceCount, total: dettesSansEcheanceTotal },
    creancesSansEcheance: { count: creancesSansEcheanceCount, total: creancesSansEcheanceTotal },
  };
}
