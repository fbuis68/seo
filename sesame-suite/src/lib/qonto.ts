import { prisma } from "../db";
import { ParsedBankTransaction, importBankTransactions, ImportBankTransactionsResult } from "./accBanking";
import { autoReconcileMany } from "./accReconciliation";
import { processUploadedDocument } from "./accPipeline";

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
export interface QontoAttachmentInfo {
  id: string;
  fileName: string;
  contentType: string;
  url: string;
}

/** Pièces jointes embarquées sur une transaction (cf. includes[]=attachments) — presentes uniquement quand Qonto (ou l'utilisateur) en a attaché une, ex. le justificatif auto-joint sur ses propres frais/abonnement. */
function extractQontoAttachments(t: any): QontoAttachmentInfo[] {
  if (!Array.isArray(t.attachments)) return [];
  return t.attachments
    .filter((a: any) => a?.id && a?.url)
    .map((a: any) => ({ id: String(a.id), fileName: a.file_name || `attachment-${a.id}`, contentType: a.file_content_type || "application/octet-stream", url: a.url }));
}

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

/**
 * Récupère toutes les transactions "completed" d'un IBAN depuis `since`
 * (paginé), tri chronologique croissant, avec en parallèle les pièces
 * jointes embarquées de chacune (§ "récupérer leurs factures et frais" —
 * includes[]=attachments embarque le justificatif que Qonto attache
 * lui-même aux débits de frais/abonnement, cf. ingestQontoFeeInvoices).
 */
async function fetchQontoTransactions(creds: QontoCredentials, iban: string, since: Date | null, labelsById: Map<string, string>): Promise<{ transactions: ParsedBankTransaction[]; attachmentsByExternalId: Map<string, QontoAttachmentInfo[]> }> {
  const out: ParsedBankTransaction[] = [];
  const attachmentsByExternalId = new Map<string, QontoAttachmentInfo[]>();
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
    // Deux "includes[]" distincts nécessaires (labels + attachments) — un
    // objet passé à URLSearchParams ne garde qu'une valeur par clé, d'où
    // ce append() séparé plutôt qu'une entrée de plus dans l'objet
    // ci-dessus. Sans "includes[]=labels", Qonto ne renvoie PAS label_ids
    // sur les transactions (constaté en production, 22/09/2026).
    params.append("includes[]", "labels");
    params.append("includes[]", "attachments");
    const json = await qontoRequest(creds, `/transactions?${params.toString()}`);
    const rows: any[] = json.transactions || [];
    for (const t of rows) {
      const mapped = mapQontoTransaction(t, labelsById);
      if (mapped) {
        out.push(mapped);
        const attachments = extractQontoAttachments(t);
        if (attachments.length && mapped.externalId) attachmentsByExternalId.set(mapped.externalId, attachments);
      }
    }
    const totalPages = json.meta?.total_pages || 1;
    if (page >= totalPages || rows.length === 0) break;
    page += 1;
  }
  return { transactions: out, attachmentsByExternalId };
}

/**
 * Ingère les justificatifs des débits QONTO ELLE-MÊME (abonnement, frais
 * de carte, virements internationaux...) comme factures d'achat — §
 * "récupérer leurs factures et frais". Repéré par nom de contrepartie
 * ("QONTO", insensible à la casse) plutôt que par catégorie de transaction
 * (l'énumération exacte des valeurs de `category` n'a pas pu être vérifiée
 * de façon fiable, cf. lib/scaleway.ts pour la même prudence sur des
 * enums non confirmés) — un débit dont Qonto est la contrepartie est sans
 * ambiguïté un frais Qonto, quelle que soit sa catégorie. Ne touche
 * jamais aux pièces jointes d'AUTRES contreparties (justificatifs
 * uploadés par l'utilisateur pour ses propres fournisseurs), qui
 * n'ont rien à faire dans ce pipeline d'ingestion automatique.
 */
async function ingestQontoFeeInvoices(
  entityId: string | null,
  transactions: ParsedBankTransaction[],
  attachmentsByExternalId: Map<string, QontoAttachmentInfo[]>
): Promise<{ invoicesIngested: number; invoicesDuplicate: number; invoicesFailed: number }> {
  let invoicesIngested = 0;
  let invoicesDuplicate = 0;
  let invoicesFailed = 0;

  for (const tx of transactions) {
    if (!tx.externalId || !tx.counterpartyName || !/qonto/i.test(tx.counterpartyName)) continue;
    const attachments = attachmentsByExternalId.get(tx.externalId);
    if (!attachments?.length) continue;
    for (const attachment of attachments) {
      try {
        const res = await fetchWithTimeout(attachment.url);
        if (!res.ok) throw new Error(`téléchargement échoué (HTTP ${res.status})`);
        const buffer = Buffer.from(await res.arrayBuffer());
        const result = await processUploadedDocument(entityId, {
          filename: attachment.fileName,
          mimeType: attachment.contentType,
          base64: buffer.toString("base64"),
          source: "api",
          direction: "purchase",
        });
        if (result.isDuplicateDocument) invoicesDuplicate += 1;
        else invoicesIngested += 1;
      } catch (e) {
        invoicesFailed += 1;
        console.warn(`[qonto] échec d'ingestion pour la pièce jointe ${attachment.id} (transaction ${tx.externalId}) : ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  return { invoicesIngested, invoicesDuplicate, invoicesFailed };
}

export interface QontoSyncResult extends ImportBankTransactionsResult {
  parsedCount: number;
  invoicesIngested: number;
  invoicesDuplicate: number;
  invoicesFailed: number;
}

/**
 * Synchronise un AccBankAccount lié à Qonto (provider="qonto",
 * providerAccountId=IBAN) — récupère les transactions nouvelles depuis le
 * dernier sync (lastSyncAt), les importe (idempotent, cf. accBanking.ts) et
 * met à jour le solde + connectionStatus.
 *
 * `full=true` ignore lastSyncAt et refait passer TOUT l'historique — jamais
 * utilisé par le planificateur (delta uniquement, cf. qontoScheduler.ts),
 * seulement à la demande (bouton dédié). Nécessaire pour rattraper des
 * champs ajoutés APRÈS l'import initial d'une transaction (ex : labels
 * analytiques assignés dans Qonto après coup, ou la résolution de labels
 * elle-même ajoutée le 22/09/2026) : le sync normal ne revisite jamais une
 * transaction déjà connue et antérieure à lastSyncAt, donc ne peut pas la
 * backfiller — constaté en production, 22/09/2026 (labels bien présents et
 * assignés côté Qonto, mais jamais remontés malgré plusieurs
 * resynchronisations "normales" sur un compte déjà connecté de longue
 * date). importBankTransactions gère déjà la mise à jour d'une transaction
 * déjà connue (upsert sur bankAccountId+externalId) — refaire passer tout
 * l'historique ne crée donc aucun doublon, seulement des mises à jour.
 */
export async function syncQontoBankAccount(bankAccountId: string, options?: { full?: boolean }): Promise<QontoSyncResult> {
  const bankAccount = await prisma.accBankAccount.findUnique({ where: { id: bankAccountId } });
  if (!bankAccount) throw new QontoError("Compte bancaire introuvable");
  if (bankAccount.provider !== "qonto" || !bankAccount.providerAccountId) {
    throw new QontoError("Ce compte bancaire n'est pas lié à Qonto");
  }

  const config = await prisma.qontoConfig.findFirst({ where: { entityId: bankAccount.entityId } });
  if (!config) throw new QontoError("Identifiants Qonto non configurés");
  const creds: QontoCredentials = { login: config.login, secretKey: config.secretKey, sandbox: config.sandbox };

  let parsed: ParsedBankTransaction[];
  let attachmentsByExternalId: Map<string, QontoAttachmentInfo[]>;
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
    const since = options?.full ? null : bankAccount.lastSyncAt;
    const fetched = await fetchQontoTransactions(creds, bankAccount.providerAccountId, since, labelsById);
    parsed = fetched.transactions;
    attachmentsByExternalId = fetched.attachmentsByExternalId;
  } catch (e) {
    await prisma.accBankAccount.update({ where: { id: bankAccount.id }, data: { connectionStatus: "error" } });
    throw e;
  }

  const result = await importBankTransactions(bankAccount.entityId, bankAccount.id, "qonto_api", parsed);
  await autoReconcileMany(result.createdIds);

  // Jamais bloquant — un échec de téléchargement/ingestion d'un
  // justificatif Qonto ne doit pas remettre en cause l'import des
  // transactions elles-mêmes (déjà terminé à ce stade).
  const feeInvoices = await ingestQontoFeeInvoices(bankAccount.entityId, parsed, attachmentsByExternalId).catch((e) => {
    console.warn(`[qonto] ingestQontoFeeInvoices a échoué : ${e instanceof Error ? e.message : e}`);
    return { invoicesIngested: 0, invoicesDuplicate: 0, invoicesFailed: 0 };
  });

  const liveAccount = orgInfo.bankAccounts.find((a) => a.iban === bankAccount.providerAccountId);

  await prisma.accBankAccount.update({
    where: { id: bankAccount.id },
    data: {
      lastSyncAt: new Date(),
      connectionStatus: "connected",
      ...(liveAccount ? { availableBalance: liveAccount.balance, accountingBalance: liveAccount.authorizedBalance } : {}),
    },
  });

  return { ...result, parsedCount: parsed.length, ...feeInvoices };
}
