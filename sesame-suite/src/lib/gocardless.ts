import { GoCardlessClient, Environments, GoCardlessException } from "gocardless-nodejs";
import { prisma } from "../db";
import { AccCustomer, AccGoCardlessPayment, AccGoCardlessPayout } from "@prisma/client";

/**
 * Connecteur GoCardless (Payments API, SDK officiel `gocardless-nodejs` —
 * contrairement à Qonto, appelé en REST brut, un SDK officiel est utilisé
 * ici : les champs exacts de l'API Qonto ont dû être devinés puis corrigés
 * après coup (labels analytiques absents sans `includes[]=labels`, cf.
 * lib/qonto.ts), un risque qu'on évite ici sur un connecteur qui touche
 * directement à l'argent des clients).
 *
 * Modèle de données GoCardless : un Payment (prélèvement individuel) est
 * rattaché à un Mandate, lui-même rattaché à un Customer — un Payment n'a
 * PAS de lien direct vers un Customer (cf. PaymentLinks). Un Payout regroupe
 * PLUSIEURS Payments en un seul virement vers le compte bancaire : c'est
 * donc le Payout (pas chaque Payment) qui doit être rapproché d'une
 * AccBankTransaction (cf. matchPayoutToBank).
 */

export class GoCardlessError extends Error {}

export interface GoCardlessCredentials {
  accessToken: string;
  sandbox: boolean;
}

export function getGoCardlessClient(creds: GoCardlessCredentials): GoCardlessClient {
  return new GoCardlessClient(creds.accessToken, creds.sandbox ? Environments.Sandbox : Environments.Live);
}

function describeError(e: unknown): string {
  if (e instanceof GoCardlessException) return e.message;
  if (e instanceof Error) return e.message;
  return "erreur inconnue";
}

/** Valide les identifiants en listant les 1ers clients — utilisé pour "Tester la connexion", aucun effet de bord. */
export async function testGoCardlessConnection(creds: GoCardlessCredentials): Promise<{ ok: true }> {
  const client = getGoCardlessClient(creds);
  try {
    await client.customers.list({ limit: 1 });
    return { ok: true };
  } catch (e) {
    throw new GoCardlessError(`Connexion GoCardless impossible : ${describeError(e)}`);
  }
}

/**
 * Rapproche (ou crée) une fiche AccCustomer pour un client GoCardless.
 * Priorité : gocardlessCustomerId déjà connu (lien stable posé lors d'un
 * rapprochement précédent) > email (même convention que matchCustomer,
 * lib/accCustomerMatching.ts, mais sans SIRET/TVA — GoCardless ne fournit
 * ni l'un ni l'autre) > création d'une nouvelle fiche. Jamais bloquant :
 * un client GoCardless sans email et sans nom exploitable reste simplement
 * non rapproché (customerId null côté AccGoCardlessPayment), cf.
 * syncGoCardlessPayments.
 */
export async function matchOrCreateCustomer(entityId: string | null, gcCustomer: { id?: string; email?: string | null; given_name?: string | null; family_name?: string | null; company_name?: string | null; country_code?: string | null }): Promise<AccCustomer | null> {
  if (!gcCustomer.id) return null;

  const name = (gcCustomer.company_name || [gcCustomer.given_name, gcCustomer.family_name].filter(Boolean).join(" ") || gcCustomer.email || "Client GoCardless sans nom").trim();

  // Déjà rapproché — remet nom/email/pays à jour à CHAQUE resynchronisation
  // (changement de raison sociale côté GoCardless, ex : société rachetée)
  // plutôt que de figer la fiche pour toujours à son premier rapprochement.
  // country_code sert notamment à repérer un prélèvement hors France (donc
  // sans TVA française applicable, cf. badge "Hors France — sans TVA" sur
  // les listes de prélèvements côté fiche client/CRM).
  const byGcId = await prisma.accCustomer.findUnique({ where: { gocardlessCustomerId: gcCustomer.id } });
  if (byGcId) {
    const data: Record<string, string> = {};
    if (name && name !== byGcId.name) data.name = name;
    if (gcCustomer.email && gcCustomer.email !== byGcId.email) data.email = gcCustomer.email;
    if (gcCustomer.country_code && gcCustomer.country_code !== byGcId.country) data.country = gcCustomer.country_code;
    return Object.keys(data).length ? prisma.accCustomer.update({ where: { id: byGcId.id }, data }) : byGcId;
  }

  if (gcCustomer.email) {
    const byEmail = await prisma.accCustomer.findFirst({ where: { entityId, email: gcCustomer.email, gocardlessCustomerId: null } });
    if (byEmail) {
      return prisma.accCustomer.update({
        where: { id: byEmail.id },
        data: { gocardlessCustomerId: gcCustomer.id, country: gcCustomer.country_code || byEmail.country },
      });
    }
  }

  return prisma.accCustomer.create({
    data: {
      entityId,
      name,
      email: gcCustomer.email || undefined,
      gocardlessCustomerId: gcCustomer.id,
      country: gcCustomer.country_code || undefined,
    },
  });
}

/** Résout mandateId -> gocardlessCustomerId pour tous les mandats de l'organisation, une seule fois par sync (§ perf, même approche que fetchQontoLabels). */
async function buildMandateCustomerMap(client: GoCardlessClient): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for await (const mandate of client.mandates.all()) {
    if (mandate.id && mandate.links?.customer) map.set(mandate.id, mandate.links.customer);
  }
  return map;
}

export interface GoCardlessSyncResult {
  customersSynced: number;
  paymentsSynced: number;
  payoutsSynced: number;
  payoutsMatched: number;
}

/** Amounts GoCardless en plus petite unité monétaire (centimes) — jamais de flottant côté API, conversion nécessaire vers les Float en euros utilisés partout ailleurs dans le module compta (cf. AccBankTransaction.amount). */
function toEuros(amountInCents: number | undefined | null): number {
  return Math.round(Number(amountInCents) || 0) / 100;
}

/**
 * Rapproche un AccGoCardlessPayout non encore lié à une AccBankTransaction —
 * même montant (± 1 centime, arrondis bancaires) et date de transaction
 * dans les 5 jours autour de arrivalDate (le virement peut arriver un jour
 * ouvré différent selon la banque). Ne rapproche jamais deux payouts à la
 * même transaction (candidats déjà liés à un autre payout exclus).
 */
async function matchPayoutToBank(entityId: string | null, payout: AccGoCardlessPayout): Promise<boolean> {
  if (payout.bankTransactionId || !payout.arrivalDate) return false;
  const from = new Date(payout.arrivalDate.getTime() - 5 * 24 * 60 * 60 * 1000);
  const to = new Date(payout.arrivalDate.getTime() + 5 * 24 * 60 * 60 * 1000);
  const candidates = await prisma.accBankTransaction.findMany({
    where: {
      entityId,
      direction: "CREDIT", // AccBankTransaction.direction est stocké en MAJUSCULES (cf. accBanking.ts) — "credit" ne matchait JAMAIS, bug trouvé le 22/09/2026 (0 rapproché en toute circonstance)
      operationDate: { gte: from, lte: to },
      gocardlessPayout: { is: null },
    },
  });
  const match = candidates.find((c) => Math.abs(c.amount - payout.amount) < 0.01);
  if (!match) return false;
  await prisma.accGoCardlessPayout.update({ where: { id: payout.id }, data: { bankTransactionId: match.id } });
  return true;
}

/**
 * Synchronise clients, mandats, prélèvements et virements GoCardless pour
 * une entité — dans cet ordre (chaque étape dépend de la précédente pour
 * la résolution client) : customers (rapprochement AccCustomer) -> mandats
 * (map mandateId->gocardlessCustomerId) -> payments (upsert par
 * gocardlessId, customerId résolu via la map) -> payouts (upsert, lie les
 * payments déjà connus, tente le rapprochement bancaire).
 */
export async function syncGoCardless(entityId: string | null): Promise<GoCardlessSyncResult> {
  const config = await prisma.goCardlessConfig.findFirst({ where: { entityId } });
  if (!config) throw new GoCardlessError("Identifiants GoCardless non configurés");
  const creds: GoCardlessCredentials = { accessToken: config.accessToken, sandbox: config.sandbox };
  const client = getGoCardlessClient(creds);

  let customersSynced = 0;
  let paymentsSynced = 0;
  let payoutsSynced = 0;
  let payoutsMatched = 0;

  try {
    for await (const gcCustomer of client.customers.all()) {
      await matchOrCreateCustomer(entityId, gcCustomer);
      customersSynced += 1;
    }

    const mandateCustomerMap = await buildMandateCustomerMap(client);

    for await (const payment of client.payments.all()) {
      if (!payment.id) continue;
      const gcCustomerId = payment.links?.mandate ? mandateCustomerMap.get(payment.links.mandate) : undefined;
      const customer = gcCustomerId ? await prisma.accCustomer.findUnique({ where: { gocardlessCustomerId: gcCustomerId } }) : null;

      await prisma.accGoCardlessPayment.upsert({
        where: { gocardlessId: payment.id },
        create: {
          entityId,
          gocardlessId: payment.id,
          customerId: customer?.id,
          mandateId: payment.links?.mandate || null,
          amount: toEuros(payment.amount),
          currency: payment.currency || "EUR",
          status: payment.status || "pending_submission",
          chargeDate: payment.charge_date ? new Date(payment.charge_date) : null,
          description: payment.description || null,
          reference: payment.reference || null,
        },
        update: {
          customerId: customer?.id,
          amount: toEuros(payment.amount),
          status: payment.status || "pending_submission",
          chargeDate: payment.charge_date ? new Date(payment.charge_date) : null,
          description: payment.description || null,
          reference: payment.reference || null,
        },
      });
      paymentsSynced += 1;
    }

    for await (const payout of client.payouts.all()) {
      if (!payout.id) continue;
      const upserted = await prisma.accGoCardlessPayout.upsert({
        where: { gocardlessId: payout.id },
        create: {
          entityId,
          gocardlessId: payout.id,
          amount: toEuros(payout.amount),
          currency: payout.currency || "EUR",
          arrivalDate: payout.arrival_date ? new Date(payout.arrival_date) : null,
          status: payout.status || "pending",
          reference: payout.reference || null,
        },
        update: {
          amount: toEuros(payout.amount),
          arrivalDate: payout.arrival_date ? new Date(payout.arrival_date) : null,
          status: payout.status || "pending",
          reference: payout.reference || null,
        },
      });
      payoutsSynced += 1;

      // Rattache les prélèvements déjà connus à ce virement (§ regroupement,
      // cf. commentaire modèle AccGoCardlessPayout) — un item de type autre
      // que "payment_paid_out" (frais GoCardless, remboursement...) n'a pas
      // de payment applicable et est simplement ignoré.
      //
      // GoCardless archive les payoutItems des payouts vieux de plus de 6
      // mois (ApiError "Payout items for payouts created more than 6 months
      // ago are archived") — constaté en production, 22/09/2026, sur un
      // compte avec de l'historique : sans ce try/catch, un SEUL vieux
      // payout faisait échouer TOUTE la synchro (clients/payments/payouts
      // suivants jamais traités). Le rapprochement bancaire (montant+date,
      // cf. matchPayoutToBank) reste possible même sans le détail par
      // client sur ces vieux payouts — seul le regroupement fin par
      // paiement individuel est perdu.
      try {
        for await (const item of client.payoutItems.all({ payout: payout.id })) {
          if (item.type !== "payment_paid_out" || !item.links?.payment) continue;
          await prisma.accGoCardlessPayment.updateMany({
            where: { gocardlessId: item.links.payment },
            data: { payoutId: upserted.id },
          });
        }
      } catch (e) {
        console.warn(`[gocardless] payoutItems indisponibles pour le payout ${payout.id} (probablement archivé, >6 mois) : ${describeError(e)}`);
      }

      if (await matchPayoutToBank(entityId, upserted)) payoutsMatched += 1;
    }
  } catch (e) {
    if (e instanceof GoCardlessError) throw e;
    throw new GoCardlessError(`Synchronisation GoCardless échouée : ${describeError(e)}`);
  }

  return { customersSynced, paymentsSynced, payoutsSynced, payoutsMatched };
}

export async function listPaymentsForCustomer(customerId: string): Promise<AccGoCardlessPayment[]> {
  return prisma.accGoCardlessPayment.findMany({ where: { customerId }, orderBy: { chargeDate: "desc" } });
}

export interface GoCardlessVatEstimate {
  vatAmount: number;
  // matched_invoice = facture du client au même montant TTC (±1 centime) —
  // TVA exacte reprise telle quelle. rate_estimate = aucune facture au
  // même montant, taux de TVA déduit de la facture la plus récente du
  // client et appliqué au prélèvement. rate_default = AUCUNE facture du
  // tout pour ce client (cas le plus fréquent en pratique : un client
  // GoCardless n'a souvent jamais de facture déposée dans le module
  // compta) — taux de TVA par défaut de GoCardlessConfig.vatRate appliqué
  // au montant TTC du prélèvement, toujours une approximation.
  // not_applicable = client hors France (cf. gcCountryBadge côté
  // crm.html).
  vatSource: "matched_invoice" | "rate_estimate" | "rate_default" | "not_applicable";
}

/** Extrait la TVA d'un montant TTC pour un taux donné (ex. 120€ à 20% -> 20€). */
function vatFromTtc(amountTtc: number, ratePct: number): number {
  return Math.round(amountTtc * (ratePct / (100 + ratePct)) * 100) / 100;
}

/** Taux de TVA par défaut configuré sur le connecteur GoCardless de cette entité (20% si jamais configuré — cf. GoCardlessConfig.vatRate). */
export async function getGoCardlessVatRate(entityId: string | null): Promise<number> {
  const config = await prisma.goCardlessConfig.findFirst({ where: { entityId } });
  return config?.vatRate ?? 20;
}

/**
 * Estime la TVA d'un prélèvement GoCardless (demande client 08/10/2026) —
 * GoCardless lui-même ne fournit AUCUNE ventilation TVA via son API (c'est
 * un simple exécuteur de prélèvements, pas un outil de facturation), donc
 * rien à "extraire" directement du payload GoCardless. Trois niveaux,
 * du plus fiable au plus approximatif : (1) facture du client au même
 * montant TTC -> TVA exacte reprise telle quelle, même principe de
 * prorata que les transactions bancaires (cf. vatShare,
 * routes/accounting.ts) ; (2) pas de montant exact mais au moins une
 * facture avec TVA -> taux déduit de la plus récente ; (3) en pratique le
 * cas le plus courant, AUCUNE facture pour ce client dans le module
 * compta (GoCardless utilisé seul, sans facturation suivie dans l'appli)
 * -> taux de TVA par défaut configuré sur le connecteur
 * (defaultVatRatePct, GoCardlessConfig.vatRate).
 */
export function estimateGoCardlessVat(
  paymentAmount: number,
  customerCountry: string | null | undefined,
  customerInvoices: { amountVat: number | null; amountTtc: number | null; invoiceDate: Date | null }[],
  defaultVatRatePct: number
): GoCardlessVatEstimate {
  if (customerCountry && customerCountry !== "FR") return { vatAmount: 0, vatSource: "not_applicable" };

  const withVat = customerInvoices.filter((inv) => inv.amountTtc != null && inv.amountVat != null);
  const exact = withVat.find((inv) => Math.abs((inv.amountTtc as number) - paymentAmount) < 0.01);
  if (exact) return { vatAmount: exact.amountVat as number, vatSource: "matched_invoice" };

  if (withVat.length) {
    const mostRecent = withVat.slice().sort((a, b) => (b.invoiceDate?.getTime() || 0) - (a.invoiceDate?.getTime() || 0))[0];
    const rate = (mostRecent.amountVat as number) / (mostRecent.amountTtc as number);
    return { vatAmount: Math.round(paymentAmount * rate * 100) / 100, vatSource: "rate_estimate" };
  }

  return { vatAmount: vatFromTtc(paymentAmount, defaultVatRatePct), vatSource: "rate_default" };
}
