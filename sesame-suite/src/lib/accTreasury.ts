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
}

function remainingDue(inv: TreasuryInvoiceRow): number {
  return Math.max(0, invoiceTotal(inv) - (inv.amountPaid || 0));
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
      select: { dueDate: true, amountHt: true, amountTtc: true, amountPaid: true },
    }),
    prisma.accInvoice.findMany({
      where: {
        entityId,
        direction: "sale",
        documentType: { notIn: NON_ACCOUNTING_DOC_TYPES },
        status: { in: UNPAID_STATUSES },
      },
      select: { dueDate: true, amountHt: true, amountTtc: true, amountPaid: true },
    }),
  ]);

  let dettesRetardCount = 0, dettesRetardTotal = 0;
  let creancesRetardCount = 0, creancesRetardTotal = 0;
  const futurePurchase: { dueDate: Date; amount: number }[] = [];
  const futureSale: { dueDate: Date; amount: number }[] = [];

  for (const inv of purchaseInvoices) {
    const remaining = remainingDue(inv);
    if (remaining <= 0.01 || !inv.dueDate) continue;
    if (inv.dueDate < today) { dettesRetardCount++; dettesRetardTotal += remaining; }
    else futurePurchase.push({ dueDate: inv.dueDate, amount: remaining });
  }
  for (const inv of saleInvoices) {
    const remaining = remainingDue(inv);
    if (remaining <= 0.01 || !inv.dueDate) continue;
    if (inv.dueDate < today) { creancesRetardCount++; creancesRetardTotal += remaining; }
    else futureSale.push({ dueDate: inv.dueDate, amount: remaining });
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
    while (occ < horizonStart) occ = addMonths(occ, step);
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
  };
}
