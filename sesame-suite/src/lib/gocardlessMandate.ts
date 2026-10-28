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
    return details.length ? details.join(" / ") : e.message || "erreur GoCardless";
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
  reference: string; // RUM, max 35 caractères
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

    const mandate = await client.mandates.create({
      links: { customer_bank_account: bankAccount.id! },
      scheme: "sepa_core",
      reference: input.reference,
    });

    return {
      gocardlessCustomerId: customer.id!,
      gocardlessBankAccountId: bankAccount.id!,
      gocardlessMandateId: mandate.id!,
      reference: input.reference,
    };
  } catch (e) {
    throw new GoCardlessError(`Échec de création du mandat SEPA GoCardless : ${describeGoCardlessError(e)}`);
  }
}

/** RUM (Référence Unique de Mandat) — max 35 caractères imposé par le
 * format SEPA (cf. mandat papier). Dérivé du nom d'entreprise (slugifié) +
 * horodatage compact, assez court pour laisser de la marge au préfixe. */
export function generateMandateReference(companyName: string): string {
  const slug = companyName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 20);
  const stamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 12); // YYYYMMDDHHmm
  return `${slug || "CLIENT"}${stamp}`.slice(0, 35);
}
