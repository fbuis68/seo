import { prisma } from "../db";
import { ParsedBankTransaction, importBankTransactions, ImportBankTransactionsResult } from "./accBanking";

/**
 * Connecteur Qonto (Business API, lecture seule) — récupère automatiquement
 * les comptes bancaires et transactions d'une organisation Qonto plutôt que
 * de compter sur un import manuel de fichier (cf. accBanking.ts, phase 1).
 * Appelé en REST brut comme tous les autres connecteurs de ce projet
 * (bookingSource.ts, eldoWallet.ts...), pas de SDK Qonto.
 *
 * Auth : header Authorization: "<login>:<secretKey>" (pas de Bearer/OAuth —
 * spécifique à cette API). Deux environnements distincts (prod/sandbox),
 * jamais mélangés.
 */

const QONTO_API_BASE = process.env.QONTO_API_BASE_OVERRIDE || "https://thirdparty.qonto.com/v2";
const QONTO_SANDBOX_API_BASE = process.env.QONTO_SANDBOX_API_BASE_OVERRIDE || "https://thirdparty-sandbox.qonto.com/v2";
const QONTO_TIMEOUT_MS = 20000;

export class QontoError extends Error {}

export interface QontoCredentials {
  login: string;
  secretKey: string;
  sandbox: boolean;
}

function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(QONTO_TIMEOUT_MS) });
}

function describeFetchError(e: unknown): string {
  if (!(e instanceof Error)) return "erreur réseau";
  if (e.name === "TimeoutError") return `délai de ${QONTO_TIMEOUT_MS / 1000}s dépassé sans réponse de Qonto`;
  const cause = (e as { cause?: unknown }).cause;
  const causeCode = cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : null;
  if (causeCode === "ENOTFOUND") return "nom de domaine introuvable (DNS)";
  if (causeCode === "ECONNREFUSED") return "connexion refusée";
  if (causeCode && /CERT|SSL|TLS/i.test(causeCode)) return `certificat TLS invalide (${causeCode})`;
  return e.message;
}

async function parseJsonResponse(res: Response, context: string): Promise<any> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const snippet = text.trim().slice(0, 200) || "(réponse vide)";
    throw new QontoError(`${context} n'est pas un JSON valide — début de la réponse reçue : "${snippet}"`);
  }
}

async function qontoRequest(creds: QontoCredentials, path: string): Promise<any> {
  const base = creds.sandbox ? QONTO_SANDBOX_API_BASE : QONTO_API_BASE;
  const url = `${base}${path}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      headers: {
        Authorization: `${creds.login}:${creds.secretKey}`,
        Accept: "application/json",
      },
    });
  } catch (e) {
    throw new QontoError(`Appel à Qonto impossible : ${describeFetchError(e)}`);
  }
  const json = await parseJsonResponse(res, "La réponse de Qonto");
  if (!res.ok) {
    const message = json?.errors?.[0]?.detail || json?.error || `Erreur HTTP ${res.status}`;
    throw new QontoError(message);
  }
  return json;
}

export interface QontoBankAccountInfo {
  iban: string;
  bic: string | null;
  name: string;
  currency: string;
  balance: number;
  authorizedBalance: number;
  status: string;
}

/** Valide les identifiants et liste les comptes bancaires (IBAN) de l'organisation — utilisé pour "Tester la connexion" et pour choisir quel IBAN lier à quel AccBankAccount. */
export async function fetchQontoOrganization(creds: QontoCredentials): Promise<{ slug: string; bankAccounts: QontoBankAccountInfo[] }> {
  const json = await qontoRequest(creds, "/organization");
  const org = json.organization;
  if (!org) throw new QontoError("Réponse Qonto inattendue : organization introuvable");
  const bankAccounts: QontoBankAccountInfo[] = (org.bank_accounts || []).map((a: any) => ({
    iban: a.iban,
    bic: a.bic || null,
    name: a.name || a.iban,
    currency: a.currency || "EUR",
    balance: Number(a.balance) || 0,
    authorizedBalance: Number(a.authorized_balance) || 0,
    status: a.status || "unknown",
  }));
  return { slug: org.slug, bankAccounts };
}

/**
 * Mappe une transaction Qonto (v2) vers ParsedBankTransaction — seules les
 * transactions "completed" sont retenues (une "pending" peut encore changer
 * de montant/être annulée, cf. §51 sur les statuts intermédiaires). L'id
 * Qonto est stable et sert directement d'externalId, pas besoin du repli
 * par hash utilisé pour les imports fichier.
 */
function mapQontoTransaction(t: any): ParsedBankTransaction | null {
  if (t.status !== "completed") return null;
  const amount = Math.abs(Number(t.amount) || 0);
  const signed = t.side === "credit" ? amount : -amount;
  const counterparty = t.counterparty?.name || t.counterparty_name || undefined;
  return {
    externalId: String(t.id),
    operationDate: new Date(t.settled_at || t.emitted_at),
    valueDate: t.settled_at ? new Date(t.settled_at) : undefined,
    amount: signed,
    currency: t.currency || "EUR",
    rawLabel: t.label || t.reference || "(sans libellé)",
    counterpartyName: counterparty,
    transactionRef: t.reference || undefined,
    paymentType: t.operation_type || undefined,
    bankCategory: t.category || undefined,
    rawData: t,
  };
}

const QONTO_PAGE_SIZE = 100;

/** Récupère toutes les transactions "completed" d'un IBAN depuis `since` (paginé), tri chronologique croissant. */
async function fetchQontoTransactions(creds: QontoCredentials, iban: string, since: Date | null): Promise<ParsedBankTransaction[]> {
  const out: ParsedBankTransaction[] = [];
  let page = 1;
  for (;;) {
    const params = new URLSearchParams({
      iban,
      "status[]": "completed",
      sort_by: "settled_at:asc",
      current_page: String(page),
      per_page: String(QONTO_PAGE_SIZE),
    });
    if (since) params.set("settled_at_from", since.toISOString());
    const json = await qontoRequest(creds, `/transactions?${params.toString()}`);
    const rows: any[] = json.transactions || [];
    for (const t of rows) {
      const mapped = mapQontoTransaction(t);
      if (mapped) out.push(mapped);
    }
    const totalPages = json.meta?.total_pages || 1;
    if (page >= totalPages || rows.length === 0) break;
    page += 1;
  }
  return out;
}

export interface QontoSyncResult extends ImportBankTransactionsResult {
  parsedCount: number;
}

/**
 * Synchronise un AccBankAccount lié à Qonto (provider="qonto",
 * providerAccountId=IBAN) — récupère les transactions nouvelles depuis le
 * dernier sync (lastSyncAt), les importe (idempotent, cf. accBanking.ts) et
 * met à jour le solde + connectionStatus.
 */
export async function syncQontoBankAccount(bankAccountId: string): Promise<QontoSyncResult> {
  const bankAccount = await prisma.accBankAccount.findUnique({ where: { id: bankAccountId } });
  if (!bankAccount) throw new QontoError("Compte bancaire introuvable");
  if (bankAccount.provider !== "qonto" || !bankAccount.providerAccountId) {
    throw new QontoError("Ce compte bancaire n'est pas lié à Qonto");
  }

  const config = await prisma.qontoConfig.findFirst({ where: { entityId: bankAccount.entityId } });
  if (!config) throw new QontoError("Identifiants Qonto non configurés");
  const creds: QontoCredentials = { login: config.login, secretKey: config.secretKey, sandbox: config.sandbox };

  let parsed: ParsedBankTransaction[];
  let orgInfo: { slug: string; bankAccounts: QontoBankAccountInfo[] };
  try {
    [parsed, orgInfo] = await Promise.all([
      fetchQontoTransactions(creds, bankAccount.providerAccountId, bankAccount.lastSyncAt),
      fetchQontoOrganization(creds),
    ]);
  } catch (e) {
    await prisma.accBankAccount.update({ where: { id: bankAccount.id }, data: { connectionStatus: "error" } });
    throw e;
  }

  const result = await importBankTransactions(bankAccount.entityId, bankAccount.id, "qonto_api", parsed);
  const liveAccount = orgInfo.bankAccounts.find((a) => a.iban === bankAccount.providerAccountId);

  await prisma.accBankAccount.update({
    where: { id: bankAccount.id },
    data: {
      lastSyncAt: new Date(),
      connectionStatus: "connected",
      ...(liveAccount ? { availableBalance: liveAccount.balance, accountingBalance: liveAccount.authorizedBalance } : {}),
    },
  });

  return { ...result, parsedCount: parsed.length };
}
