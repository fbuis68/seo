import { prisma } from "../db";
import { getGoCardlessClient, GoCardlessError } from "./gocardless";
import { ApiError } from "gocardless-nodejs";

/**
 * Création d'un mandat de prélèvement SEPA via GoCardless (27/10/2026,
 * demande client — signature d'un contrat avec mandat bancaire joint, cf.
 * routes/crmSignature.ts). Distinct de gocardless.ts, qui ne fait QUE
 * synchroniser (lecture) clients/mandats/paiements déjà existants — ici on
 * CRÉE réellement un Customer + CustomerBankAccount + Mandate.
 *
 * Portée toujours entityId=null (compte GoCardless de Sesame elle-même, pas
 * celui d'un établissement hôtelier — même convention que getSmtpConfig(null)
 * pour l'envoi des signatures).
 *
 * Sécurité impérative : l'IBAN n'est JAMAIS écrit en base par ce module —
 * transmis à GoCardless (qui le tokenise) puis jamais réutilisé après le
 * retour de cet appel.
 */

function describeGoCardlessError(e: unknown): string {
  if (e instanceof ApiError) {
    const details = (e.errors || []).map((err) => [err.field, err.message].filter(Boolean).join(" : ")).filter(Boolean);
    const base = details.length ? details.join(" / ") : e.message || "erreur GoCardless";
    // Le message brut ("Forbidden request") est parfois trop pauvre pour
    // diagnostiquer — errorType/code/documentationUrl donnent le vrai motif
    // (ex: restriction de fonctionnalité du compte créancier).
    return `${base} [errorType=${e.errorType || "?"} code=${e.code || "?"} doc=${e.documentationUrl || "?"}]`;
  }
  return e instanceof Error ? e.message : "erreur GoCardless inconnue";
}

export interface SepaMandateInput {
  companyName: string;
  contactEmail: string;
  addressLine1?: string;
  postalCode?: string;
  city?: string;
  accountHolderName: string;
  iban: string; // jamais persisté — transmis puis oublié
}

export interface SepaMandateResult {
  gocardlessCustomerId: string;
  gocardlessBankAccountId: string;
  gocardlessMandateId: string;
  reference: string;
}

/**
 * Crée le Customer (ou le réutilise si l'email existe déjà), le
 * CustomerBankAccount puis le Mandate SEPA — dans cet ordre, requis par
 * l'API GoCardless (un compte bancaire est toujours rattaché à un client,
 * un mandat à un compte bancaire).
 */
export async function createSepaMandate(input: SepaMandateInput): Promise<SepaMandateResult> {
  const config = await prisma.goCardlessConfig.findFirst({ where: { entityId: null } });
  if (!config) throw new GoCardlessError("Identifiants GoCardless non configurés (portée CRM) — voir Paramétrage > Comptabilité");
  const client = getGoCardlessClient({ accessToken: config.accessToken, sandbox: config.sandbox });

  try {
    const customer = await client.customers.create({
      company_name: input.companyName,
      email: input.contactEmail,
      address_line1: input.addressLine1 || undefined,
      postal_code: input.postalCode || undefined,
      city: input.city || undefined,
      country_code: "FR",
    });

    const bankAccount = await client.customerBankAccounts.create({
      iban: input.iban.replace(/\s/g, "").toUpperCase(),
      account_holder_name: input.accountHolderName,
      links: { customer: customer.id! },
    });

    // Pas de `reference` imposée ici : certains identifiants créancier
    // GoCardless (can_specify_mandate_reference=false) rejettent toute
    // référence custom ("Custom mandate references are not enabled for
    // your scheme identifier", vu en test réel 28/10/2026) — on laisse
    // GoCardless générer la sienne et on la reprend telle quelle.
    const mandate = await client.mandates.create({
      links: { customer_bank_account: bankAccount.id! },
      scheme: "sepa_core",
    });
    if (!mandate.reference) throw new GoCardlessError("Mandat créé côté GoCardless sans référence retournée — cas inattendu");

    return {
      gocardlessCustomerId: customer.id!,
      gocardlessBankAccountId: bankAccount.id!,
      gocardlessMandateId: mandate.id!,
      reference: mandate.reference,
    };
  } catch (e) {
    throw new GoCardlessError(`Échec de création du mandat SEPA GoCardless : ${describeGoCardlessError(e)}`);
  }
}
