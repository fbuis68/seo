import { prisma } from "../db";
import { processUploadedDocument } from "./accPipeline";

/**
 * Connecteur Scaleway (facturation) — REST brut, comme Qonto (§ pas de
 * dépendance : le SDK officiel @scaleway/sdk-billing/@scaleway/sdk-client
 * est publié en ESM pur, sans build CJS ni condition "require" — pas
 * chargeable statiquement dans ce projet CommonJS sans changer
 * `moduleResolution`/`module` dans tsconfig.json pour TOUT le projet,
 * bien trop risqué pour deux connecteurs). Champs et endpoints vérifiés
 * via node_modules/@scaleway/sdk-billing (installé puis désinstallé
 * uniquement pour lire ses .d.ts générés) plutôt que devinés — même
 * niveau de certitude qu'avec un SDK, cf. le SDK Go officiel
 * (scaleway-sdk-go/api/billing/v2beta1) qui donne les mêmes noms de
 * champs JSON snake_case.
 *
 * Récupère les factures Scaleway et les fait passer par le PIPELINE
 * D'INGESTION NORMAL (processUploadedDocument, lib/accPipeline.ts) —
 * exactement comme un upload manuel ou un import email : OCR/extraction/
 * rapprochement fournisseur/contrôles de cohérence tournent normalement
 * dessus, et le hash du PDF déduplique naturellement les factures déjà
 * importées (aucun suivi d'id externe nécessaire en plus).
 */

const SCALEWAY_API_BASE = process.env.SCALEWAY_API_BASE_OVERRIDE || "https://api.scaleway.com";
const SCALEWAY_TIMEOUT_MS = 20000;
const SCALEWAY_PAGE_SIZE = 100;

export class ScalewayError extends Error {}

export interface ScalewayCredentials {
  accessKey: string;
  secretKey: string;
  organizationId?: string | null;
}

function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(SCALEWAY_TIMEOUT_MS) });
}

function describeFetchError(e: unknown): string {
  if (!(e instanceof Error)) return "erreur réseau";
  if (e.name === "TimeoutError") return `délai de ${SCALEWAY_TIMEOUT_MS / 1000}s dépassé sans réponse de Scaleway`;
  return e.message;
}

async function scalewayRequest(creds: ScalewayCredentials, path: string): Promise<any> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${SCALEWAY_API_BASE}${path}`, {
      headers: { "X-Auth-Token": creds.secretKey, Accept: "application/json" },
    });
  } catch (e) {
    throw new ScalewayError(`Appel à Scaleway impossible : ${describeFetchError(e)}`);
  }
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ScalewayError(`La réponse de Scaleway n'est pas un JSON valide — début : "${text.trim().slice(0, 200) || "(réponse vide)"}"`);
  }
  if (!res.ok) {
    throw new ScalewayError(json?.message || `Erreur HTTP ${res.status}`);
  }
  return json;
}

/** Money Scaleway (units + nanos, cf. googleapis.type.Money) -> euros décimaux. */
function moneyToFloat(m: { units?: number; nanos?: number } | null | undefined): number {
  if (!m) return 0;
  return (m.units || 0) + (m.nanos || 0) / 1e9;
}

interface ScalewayInvoice {
  id: string;
  number: number;
  type: string;
  state: string;
  totalUntaxed: number;
  totalTaxed: number;
  totalTax: number;
}

async function fetchScalewayInvoices(creds: ScalewayCredentials): Promise<ScalewayInvoice[]> {
  const out: ScalewayInvoice[] = [];
  let page = 1;
  for (;;) {
    const params = new URLSearchParams({ page: String(page), page_size: String(SCALEWAY_PAGE_SIZE) });
    if (creds.organizationId) params.set("organization_id", creds.organizationId);
    const json = await scalewayRequest(creds, `/billing/v2beta1/invoices?${params.toString()}`);
    const rows: any[] = json.invoices || [];
    for (const inv of rows) {
      out.push({
        id: String(inv.id),
        number: Number(inv.number),
        type: inv.type,
        state: inv.state,
        totalUntaxed: moneyToFloat(inv.total_untaxed),
        totalTaxed: moneyToFloat(inv.total_taxed),
        totalTax: moneyToFloat(inv.total_tax),
      });
    }
    const totalPages = Math.ceil((json.total_count || 0) / SCALEWAY_PAGE_SIZE);
    if (page >= totalPages || rows.length === 0) break;
    page += 1;
  }
  return out;
}

async function downloadScalewayInvoicePdf(creds: ScalewayCredentials, invoiceId: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${SCALEWAY_API_BASE}/billing/v2beta1/invoices/${invoiceId}/download?file_type=pdf`, {
      headers: { "X-Auth-Token": creds.secretKey },
    });
  } catch (e) {
    throw new ScalewayError(`Téléchargement de la facture Scaleway ${invoiceId} impossible : ${describeFetchError(e)}`);
  }
  if (!res.ok) throw new ScalewayError(`Téléchargement de la facture Scaleway ${invoiceId} échoué (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Valide les identifiants en listant 1 facture — utilisé pour "Tester la connexion", aucun effet de bord. */
export async function testScalewayConnection(creds: ScalewayCredentials): Promise<{ ok: true }> {
  try {
    const params = new URLSearchParams({ page: "1", page_size: "1" });
    if (creds.organizationId) params.set("organization_id", creds.organizationId);
    await scalewayRequest(creds, `/billing/v2beta1/invoices?${params.toString()}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ScalewayError) throw e;
    throw new ScalewayError(`Connexion Scaleway impossible : ${describeFetchError(e)}`);
  }
}

export interface ScalewaySyncResult {
  invoicesSeen: number;
  invoicesIngested: number;
  invoicesDuplicate: number;
  invoicesFailed: number;
}

/**
 * Synchronise les factures Scaleway — pour chaque facture, télécharge le
 * PDF et le fait passer par processUploadedDocument comme n'importe quel
 * autre document. Une facture déjà importée (même hash de fichier) est
 * comptée en doublon plutôt que ré-ingérée, sans erreur ni duplication.
 */
export async function syncScaleway(entityId: string | null): Promise<ScalewaySyncResult> {
  const config = await prisma.scalewayConfig.findFirst({ where: { entityId } });
  if (!config) throw new ScalewayError("Identifiants Scaleway non configurés");
  const creds: ScalewayCredentials = { accessKey: config.accessKey, secretKey: config.secretKey, organizationId: config.organizationId };

  let invoices: ScalewayInvoice[];
  try {
    invoices = await fetchScalewayInvoices(creds);
  } catch (e) {
    if (e instanceof ScalewayError) throw e;
    throw new ScalewayError(`Synchronisation Scaleway échouée (liste des factures) : ${describeFetchError(e)}`);
  }

  let invoicesIngested = 0;
  let invoicesDuplicate = 0;
  let invoicesFailed = 0;

  for (const invoice of invoices) {
    try {
      const buffer = await downloadScalewayInvoicePdf(creds, invoice.id);
      const result = await processUploadedDocument(entityId, {
        filename: `scaleway-${invoice.number || invoice.id}.pdf`,
        mimeType: "application/pdf",
        base64: buffer.toString("base64"),
        source: "api",
        direction: "purchase",
      });
      if (result.isDuplicateDocument) invoicesDuplicate += 1;
      else invoicesIngested += 1;
    } catch (e) {
      invoicesFailed += 1;
      console.warn(`[scaleway] échec d'ingestion pour la facture ${invoice.id} : ${e instanceof Error ? e.message : e}`);
    }
  }

  return { invoicesSeen: invoices.length, invoicesIngested, invoicesDuplicate, invoicesFailed };
}
