import { prisma } from "../db";
import { ParsedBankTransaction, importBankTransactions, ImportBankTransactionsResult } from "./accBanking";
import { autoReconcileMany } from "./accReconciliation";

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
 * Labels analytiques Qonto (fonctionnalité "comptabilité analytique" de
 * Qonto — l'utilisateur y crée ses propres étiquettes, ex. "Établissement >
 * Vichy", regroupées en listes) — résolus une seule fois par synchronisation
 * plutôt qu'un appel par transaction (§ perf, cf. syncQontoBankAccount).
 * Chaque transaction ne référence que des `label_ids` ; un id absent de la
 * réponse (label supprimé depuis) est simplement ignoré plutôt que de faire
 * échouer tout le mapping.
 */
async function fetchQontoLabels(creds: QontoCredentials): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let page = 1;
  for (;;) {
    const json = await qontoRequest(creds, `/labels?current_page=${page}&per_page=100`);
    for (const l of json.labels || []) {
      if (l?.id && l?.name) map.set(String(l.id), String(l.name));
    }
    const totalPages = json.meta?.total_pages || 1;
    if (page >= totalPages || !(json.labels || []).length) break;
    page += 1;
  }
  return map;
}

/**
 * Mappe une transaction Qonto (v2) vers ParsedBankTransaction — seules les
 * transactions "completed" sont retenues (une "pending" peut encore changer
 * de montant/être annulée, cf. §51 sur les statuts intermédiaires). L'id
 * Qonto est stable et sert directement d'externalId, pas besoin du repli
 * par hash utilisé pour les imports fichier.
 */
function mapQontoTransaction(t: any, labelsById: Map<string, string>): ParsedBankTransaction | null {
  if (t.status !== "completed") return null;
  const amount = Math.abs(Number(t.amount) || 0);
  const signed = t.side === "credit" ? amount : -amount;
  const counterparty = t.counterparty?.name || t.counterparty_name || undefined;
  // Deux formes possibles selon la version de l'API/le paramètre includes[]
  // utilisé : `label_ids` (juste les ids, à résoudre via labelsById) ou des
  // objets déjà enrichis sous `labels` (ex : includes[]=labels peut aussi
  // embarquer l'objet complet plutôt qu'une simple liste d'ids selon les
  // endpoints Qonto) — les deux sont acceptées plutôt que de parier sur une
  // seule forme, non vérifiable dans cet environnement (pas d'accès à un
  // vrai compte Qonto).
  const labelsFromIds = ((t.label_ids || []) as unknown[]).map((id) => labelsById.get(String(id))).filter((n): n is string => !!n);
  const labelsFromEmbedded = Array.isArray(t.labels)
    ? (t.labels as any[]).map((l) => (typeof l === "string" ? l : l?.name)).filter((n): n is string => !!n)
    : [];
  const labels = [...new Set([...labelsFromIds, ...labelsFromEmbedded])];
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
    labels,
    rawData: t,
  };
}

const QONTO_PAGE_SIZE = 100;

/** Récupère toutes les transactions "completed" d'un IBAN depuis `since` (paginé), tri chronologique croissant. */
async function fetchQontoTransactions(creds: QontoCredentials, iban: string, since: Date | null, labelsById: Map<string, string>): Promise<ParsedBankTransaction[]> {
  const out: ParsedBankTransaction[] = [];
  let page = 1;
  for (;;) {
    const params = new URLSearchParams({
      iban,
      "status[]": "completed",
      sort_by: "settled_at:asc",
      current_page: String(page),
      per_page: String(QONTO_PAGE_SIZE),
      // Sans ce paramètre, Qonto ne renvoie PAS label_ids sur les
      // transactions — labels analytiques toujours absents en pratique quel
      // que soit le contenu de fetchQontoLabels (constaté en production,
      // 22/09/2026 : le mapping id→nom était correct mais rien à mapper,
      // l'API ne renvoyant jamais label_ids sans includes[]=labels).
      "includes[]": "labels",
    });
    if (since) params.set("settled_at_from", since.toISOString());
    const json = await qontoRequest(creds, `/transactions?${params.toString()}`);
    const rows: any[] = json.transactions || [];
    for (const t of rows) {
      const mapped = mapQontoTransaction(t, labelsById);
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
    const [labelsById, orgInfoResult] = await Promise.all([
      // Labels analytiques : jamais bloquant, une organisation sans label
      // configuré ou un endpoint indisponible ne doit pas casser la
      // synchronisation — mais logué (pas juste avalé en silence) pour
      // pouvoir diagnostiquer un vrai problème d'API (ex : forme de réponse
      // Qonto différente de celle attendue) sans que "aucun label" et "échec
      // d'appel" soient indiscernables depuis l'interface.
      fetchQontoLabels(creds).catch((e) => {
        console.warn(`[qonto] fetchQontoLabels a échoué (labels analytiques non résolus pour ce sync) : ${e instanceof Error ? e.message : e}`);
        return new Map<string, string>();
      }),
      fetchQontoOrganization(creds),
    ]);
    orgInfo = orgInfoResult;
    parsed = await fetchQontoTransactions(creds, bankAccount.providerAccountId, bankAccount.lastSyncAt, labelsById);
  } catch (e) {
    await prisma.accBankAccount.update({ where: { id: bankAccount.id }, data: { connectionStatus: "error" } });
    throw e;
  }

  const result = await importBankTransactions(bankAccount.entityId, bankAccount.id, "qonto_api", parsed);
  await autoReconcileMany(result.createdIds);
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
