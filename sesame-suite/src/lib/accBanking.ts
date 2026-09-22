import { createHash } from "crypto";
import { XMLParser } from "fast-xml-parser";
import { prisma } from "../db";
import { Prisma } from "@prisma/client";

export class BankImportError extends Error {}

export type BankImportSource = "csv" | "camt053" | "mt940" | "cfonb";

export interface ParsedBankTransaction {
  externalId?: string;
  operationDate: Date;
  valueDate?: Date;
  /** Signé : positif = crédit, négatif = débit. */
  amount: number;
  currency: string;
  rawLabel: string;
  counterpartyName?: string;
  counterpartyIban?: string;
  counterpartyBic?: string;
  transactionRef?: string;
  endToEndId?: string;
  sepaMandateRef?: string;
  creditorRef?: string;
  paymentType?: string;
  bankCategory?: string;
  /** Labels analytiques Qonto (noms résolus) — vide pour tout import hors Qonto. */
  labels?: string[];
  rawData: unknown;
}

/**
 * Identifiant de repli pour les sources sans identifiant natif stable
 * (ex. CSV sans colonne référence) — même logique que computeSha256 dans
 * accDocument.ts, appliquée aux champs qui identifient une transaction de
 * façon quasi-unique en pratique (date + montant + libellé brut).
 */
export function fallbackExternalId(tx: Pick<ParsedBankTransaction, "operationDate" | "amount" | "rawLabel">): string {
  const key = `${tx.operationDate.toISOString().slice(0, 10)}|${tx.amount.toFixed(2)}|${tx.rawLabel.trim().toLowerCase()}`;
  return createHash("sha256").update(key).digest("hex");
}

function parseFrenchAmount(raw: string): number {
  const cleaned = raw.trim().replace(/\s| /g, "").replace(/,/g, ".");
  const n = Number(cleaned);
  if (Number.isNaN(n)) throw new BankImportError(`Montant illisible: "${raw}"`);
  return n;
}

function parseFlexibleDate(raw: string): Date {
  const s = raw.trim();
  // ISO: 2026-09-21
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // FR: 21/09/2026 ou 21/09/26
  m = /^(\d{2})\/(\d{2})\/(\d{2,4})$/.exec(s);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1])));
  }
  throw new BankImportError(`Date illisible: "${raw}"`);
}

function detectDelimiter(headerLine: string): "," | ";" {
  return (headerLine.match(/;/g) || []).length >= (headerLine.match(/,/g) || []).length ? ";" : ",";
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

const HEADER_ALIASES: Record<string, string[]> = {
  date: ["date", "date operation", "date opération", "dateoperation"],
  label: ["libelle", "libellé", "label", "description", "détail", "detail"],
  amount: ["montant", "amount"],
  debit: ["debit", "débit"],
  credit: ["credit", "crédit"],
  ref: ["reference", "référence", "ref"],
  currency: ["devise", "currency"],
};

function matchHeader(headers: string[]): Record<string, number> {
  const norm = headers.map((h) => h.trim().toLowerCase());
  const idx: Record<string, number> = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const found = norm.findIndex((h) => aliases.includes(h));
    if (found >= 0) idx[key] = found;
  }
  return idx;
}

/**
 * CSV bancaire "générique" — formats les plus courants des banques
 * françaises (date/libellé/montant, ou date/libellé/débit/crédit séparés),
 * délimiteur virgule ou point-virgule auto-détecté.
 */
export function parseCsv(content: string): ParsedBankTransaction[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new BankImportError("Fichier CSV vide ou sans données");
  const delimiter = detectDelimiter(lines[0]);
  const headers = splitCsvLine(lines[0], delimiter);
  const idx = matchHeader(headers);
  if (idx.date === undefined) throw new BankImportError("Colonne date introuvable dans le CSV");
  if (idx.label === undefined) throw new BankImportError("Colonne libellé introuvable dans le CSV");
  if (idx.amount === undefined && (idx.debit === undefined || idx.credit === undefined)) {
    throw new BankImportError("Colonne montant (ou débit/crédit) introuvable dans le CSV");
  }

  const out: ParsedBankTransaction[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i], delimiter);
    if (cols.every((c) => !c)) continue;
    const rawLabel = cols[idx.label] || "";
    let amount: number;
    if (idx.amount !== undefined) {
      amount = parseFrenchAmount(cols[idx.amount] || "0");
    } else {
      const debit = cols[idx.debit!] ? parseFrenchAmount(cols[idx.debit!]) : 0;
      const credit = cols[idx.credit!] ? parseFrenchAmount(cols[idx.credit!]) : 0;
      amount = credit - Math.abs(debit);
    }
    out.push({
      operationDate: parseFlexibleDate(cols[idx.date]),
      amount,
      currency: idx.currency !== undefined ? cols[idx.currency] || "EUR" : "EUR",
      rawLabel,
      transactionRef: idx.ref !== undefined ? cols[idx.ref] || undefined : undefined,
      externalId: idx.ref !== undefined && cols[idx.ref] ? cols[idx.ref] : undefined,
      rawData: Object.fromEntries(headers.map((h, j) => [h, cols[j]])),
    });
  }
  return out;
}

/**
 * CAMT.053 (ISO 20022) — relevé de compte XML, format standard des banques
 * européennes et de l'Open Banking (DSP2).
 */
export function parseCamt053(content: string): ParsedBankTransaction[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  let doc: any;
  try {
    doc = parser.parse(content);
  } catch (e) {
    throw new BankImportError(`XML CAMT.053 invalide: ${(e as Error).message}`);
  }
  const stmt = doc?.Document?.BkToCstmrStmt?.Stmt;
  if (!stmt) throw new BankImportError("Structure CAMT.053 inattendue: BkToCstmrStmt.Stmt introuvable");
  const stmts = Array.isArray(stmt) ? stmt : [stmt];

  const out: ParsedBankTransaction[] = [];
  for (const s of stmts) {
    const entries = s.Ntry ? (Array.isArray(s.Ntry) ? s.Ntry : [s.Ntry]) : [];
    for (const ntry of entries) {
      const amountRaw = ntry.Amt;
      const amountValue = typeof amountRaw === "object" ? Number(amountRaw["#text"]) : Number(amountRaw);
      const currency = typeof amountRaw === "object" ? amountRaw["@_Ccy"] || "EUR" : "EUR";
      const sign = ntry.CdtDbtInd === "DBIT" ? -1 : 1;
      const opDate = ntry.BookgDt?.Dt || ntry.BookgDt?.DtTm;
      const valDate = ntry.ValDt?.Dt || ntry.ValDt?.DtTm;
      if (!opDate) continue;

      const txDtls = ntry.NtryDtls?.TxDtls;
      const tx = Array.isArray(txDtls) ? txDtls[0] : txDtls;
      const rmtInf = tx?.RmtInf?.Ustrd;
      const rawLabel = (Array.isArray(rmtInf) ? rmtInf.join(" ") : rmtInf) || ntry.AddtlNtryInf || "(sans libellé)";
      const dbtr = tx?.RltdPties?.Dbtr?.Nm;
      const cdtr = tx?.RltdPties?.Cdtr?.Nm;
      const counterpartyName = sign > 0 ? dbtr : cdtr;
      const counterpartyIban = sign > 0 ? tx?.RltdPties?.DbtrAcct?.Id?.IBAN : tx?.RltdPties?.CdtrAcct?.Id?.IBAN;
      const counterpartyBic = sign > 0 ? tx?.RltdAgts?.DbtrAgt?.FinInstnId?.BICFI : tx?.RltdAgts?.CdtrAgt?.FinInstnId?.BICFI;
      const endToEndId = tx?.Refs?.EndToEndId;
      const sepaMandateRef = tx?.Refs?.MndtId;
      const acctSvcrRef = ntry.AcctSvcrRef || tx?.Refs?.AcctSvcrRef;

      out.push({
        externalId: acctSvcrRef || undefined,
        operationDate: parseFlexibleDate(String(opDate)),
        valueDate: valDate ? parseFlexibleDate(String(valDate)) : undefined,
        amount: sign * Math.abs(amountValue),
        currency,
        rawLabel: String(rawLabel),
        counterpartyName: counterpartyName ? String(counterpartyName) : undefined,
        counterpartyIban: counterpartyIban ? String(counterpartyIban) : undefined,
        counterpartyBic: counterpartyBic ? String(counterpartyBic) : undefined,
        endToEndId: endToEndId ? String(endToEndId) : undefined,
        sepaMandateRef: sepaMandateRef ? String(sepaMandateRef) : undefined,
        bankCategory: ntry.BkTxCd?.Domn?.Cd ? String(ntry.BkTxCd.Domn.Cd) : undefined,
        rawData: ntry,
      });
    }
  }
  return out;
}

/**
 * MT940 (SWIFT) — relevé au format ligne-par-ligne, encore utilisé par
 * certaines banques pour l'export manuel/EBICS.
 */
export function parseMt940(content: string): ParsedBankTransaction[] {
  const lines = content.split(/\r?\n/);
  const out: ParsedBankTransaction[] = [];

  let pendingTag: string | null = null;
  let pendingValue = "";
  let current: Partial<ParsedBankTransaction> & { _line61?: string } = {};

  const flush61 = () => {
    if (!current._line61) return;
    // :61:YYMMDD[MMDD]C|D[R]Amount[TxType][Ref]
    const m = /^(\d{6})(\d{4})?([CD])R?([0-9,]+)([A-Z][A-Z0-9]{3})?(?:\/\/(\S+))?/.exec(current._line61);
    if (!m) throw new BankImportError(`Ligne :61: MT940 illisible: "${current._line61}"`);
    const [, yymmdd, , cd, amtStr, , ref] = m;
    const year = 2000 + Number(yymmdd.slice(0, 2));
    const month = Number(yymmdd.slice(2, 4)) - 1;
    const day = Number(yymmdd.slice(4, 6));
    const amount = parseFrenchAmount(amtStr) * (cd === "D" ? -1 : 1);
    out.push({
      operationDate: new Date(Date.UTC(year, month, day)),
      amount,
      currency: "EUR",
      rawLabel: current.rawLabel || "(sans libellé)",
      transactionRef: ref,
      externalId: ref,
      rawData: { line61: current._line61, line86: current.rawLabel },
    });
    current = {};
  };

  const applyTag = (tag: string, value: string) => {
    if (tag === "61") {
      flush61();
      current._line61 = value;
    } else if (tag === "86") {
      current.rawLabel = value;
    }
  };

  for (const line of lines) {
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(line);
    if (m) {
      if (pendingTag) applyTag(pendingTag, pendingValue);
      pendingTag = m[1];
      pendingValue = m[2];
    } else if (pendingTag) {
      pendingValue += line;
    }
  }
  if (pendingTag) applyTag(pendingTag, pendingValue);
  flush61();

  return out;
}

/**
 * CFONB (format bancaire français historique, largeur fixe) — la structure
 * exacte des colonnes varie selon les variantes (120/240 caractères, relevé
 * vs virement) et je n'ai pas de fichier réel pour calibrer un parseur
 * fiable. Mieux vaut échouer clairement ici plutôt que de deviner des
 * offsets et corrompre silencieusement des montants réels.
 */
export function parseCfonb(_content: string): ParsedBankTransaction[] {
  throw new BankImportError(
    "Import CFONB non encore disponible : le format nécessite un fichier réel pour calibrer le parseur (largeur des colonnes variable selon la banque). Utilisez CSV, CAMT.053 ou MT940 en attendant, ou fournissez un exemple de fichier CFONB.",
  );
}

export function parseBankFile(source: BankImportSource, content: string): ParsedBankTransaction[] {
  switch (source) {
    case "csv":
      return parseCsv(content);
    case "camt053":
      return parseCamt053(content);
    case "mt940":
      return parseMt940(content);
    case "cfonb":
      return parseCfonb(content);
    default:
      throw new BankImportError(`Source d'import inconnue: ${source}`);
  }
}

export interface ImportBankTransactionsResult {
  created: number;
  skipped: number;
  // Ids des transactions effectivement créées par cet appel (pas les
  // ignorées) — permet à l'appelant de lancer le rapprochement automatique
  // (phase 3, lib/accReconciliation.ts) uniquement sur les nouvelles lignes
  // plutôt que de rebalayer tout l'historique à chaque import.
  createdIds: string[];
}

/**
 * Insertion idempotente : une transaction déjà importée (même
 * bankAccountId + externalId) est simplement ignorée, ce qui permet de
 * réimporter un relevé qui chevauche le précédent sans créer de doublons.
 */
export async function importBankTransactions(
  entityId: string | null,
  bankAccountId: string,
  source: BankImportSource | "qonto_api",
  parsed: ParsedBankTransaction[],
): Promise<ImportBankTransactionsResult> {
  let created = 0;
  let skipped = 0;
  const createdIds: string[] = [];

  for (const tx of parsed) {
    const externalId = tx.externalId?.trim() || fallbackExternalId(tx);
    try {
      const row = await prisma.accBankTransaction.create({
        data: {
          entityId,
          bankAccountId,
          externalId,
          operationDate: tx.operationDate,
          valueDate: tx.valueDate,
          amount: tx.amount,
          direction: tx.amount >= 0 ? "CREDIT" : "DEBIT",
          currency: tx.currency,
          rawLabel: tx.rawLabel,
          counterpartyName: tx.counterpartyName,
          counterpartyIban: tx.counterpartyIban,
          counterpartyBic: tx.counterpartyBic,
          transactionRef: tx.transactionRef,
          endToEndId: tx.endToEndId,
          sepaMandateRef: tx.sepaMandateRef,
          creditorRef: tx.creditorRef,
          paymentType: tx.paymentType,
          bankCategory: tx.bankCategory,
          qontoLabels: tx.labels || [],
          source,
          rawData: tx.rawData as Prisma.InputJsonValue,
        },
      });
      created++;
      createdIds.push(row.id);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        skipped++;
        continue;
      }
      throw e;
    }
  }

  return { created, skipped, createdIds };
}
