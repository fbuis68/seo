import { prisma } from "../db";
import type { LockerSourceConfig, Entity, Product } from "@prisma/client";

// Connecteur Mon Casier Frais (docs.moncasierfrais.fr/api, version consultée
// le 28/08/2026) — casiers réfrigérés vendant des produits locaux, associés
// à cet établissement via un "module" (une installation physique de
// casiers). Contrairement à bookingSource.ts (générique, la forme de l'API
// PMS cible est inconnue à l'avance), c'est une API réelle et documentée à
// endpoints fixes : pas de chemins/mapping configurables ici, seulement les
// identifiants et le module concerné. Leur documentation présente l'API
// comme "actuellement en lecture seule" côté leurs clients : on ne fait que
// LIRE leur catalogue/stock, et on écrit uniquement pour réserver/annuler un
// casier (bookLockers/cancelOrder), jamais pour modifier leur catalogue.

const CONNECTOR_TIMEOUT_MS = 15000;

function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(CONNECTOR_TIMEOUT_MS) });
}

export class LockerSourceError extends Error {}

function baseUrl(config: LockerSourceConfig): string {
  return (config.baseUrl || "https://api.moncasierfrais.fr/v1").replace(/\/$/, "");
}

function authHeaders(config: LockerSourceConfig): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${config.apiToken}` };
  if (config.sellerGroupId) headers.SellerGroupId = config.sellerGroupId;
  return headers;
}

async function parseJsonResponse(res: Response): Promise<any> {
  const text = await res.text();
  let json: any = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new LockerSourceError(`Réponse non JSON de Mon Casier Frais (HTTP ${res.status})`);
    }
  }
  if (!res.ok || json?.success === false) {
    throw new LockerSourceError(json?.error || `Erreur HTTP ${res.status} — Mon Casier Frais`);
  }
  return json;
}

async function mcfGet(config: LockerSourceConfig, path: string): Promise<any> {
  if (!config.apiToken) throw new LockerSourceError("Jeton API Mon Casier Frais non configuré");
  let res: Response;
  try {
    res = await fetchWithTimeout(baseUrl(config) + path, {
      headers: { Accept: "application/json", "User-Agent": "SesameSuite-LockerConnector/1.0", ...authHeaders(config) },
    });
  } catch (e) {
    throw new LockerSourceError(`Connexion à Mon Casier Frais impossible : ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseJsonResponse(res);
}

async function mcfPost(config: LockerSourceConfig, path: string, body: unknown): Promise<any> {
  if (!config.apiToken) throw new LockerSourceError("Jeton API Mon Casier Frais non configuré");
  let res: Response;
  try {
    res = await fetchWithTimeout(baseUrl(config) + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "SesameSuite-LockerConnector/1.0",
        ...authHeaders(config),
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new LockerSourceError(`Connexion à Mon Casier Frais impossible : ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseJsonResponse(res);
}

/** La doc ne montre pas toujours l'enveloppe exacte des listes "brutes"
 * (modules, lockers…) — contrairement aux endpoints catalogue, entièrement
 * documentés avec {success,products:{count,rows}}. Tolère un tableau nu, un
 * champ `rows`/`data`, l'une des clés candidates, ou à défaut la première
 * valeur-tableau trouvée dans l'objet, plutôt que de planter sur une forme
 * inattendue. */
function extractRows(json: any, ...candidateKeys: string[]): any[] {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.rows)) return json.rows;
  if (Array.isArray(json?.data)) return json.data;
  for (const k of candidateKeys) {
    if (Array.isArray(json?.[k])) return json[k];
    if (Array.isArray(json?.[k]?.rows)) return json[k].rows;
  }
  if (json && typeof json === "object") {
    for (const v of Object.values(json)) {
      if (Array.isArray(v)) return v as any[];
    }
  }
  return [];
}

export async function fetchModules(
  config: LockerSourceConfig
): Promise<{ modules: { id: string; name: string; location?: string; isOnline?: boolean }[]; raw: unknown }> {
  const json = await mcfGet(config, "/modules");
  return { modules: extractRows(json, "modules", "data"), raw: json };
}

interface McfLocker {
  numberOnModule: number;
  lockerPrice: number;
  state: number;
}

interface McfPackagingOption {
  quantity: number;
  lockers: McfLocker[];
  totalAvailable: number;
  price: number;
}

interface McfRealtimeProduct {
  id: string;
  name: string;
  apiField?: string;
  description?: string;
  perUnit: boolean;
  VAT: number;
  price: number;
  packagingOptions: McfPackagingOption[];
}

/** GET /v1/catalog/realtime/{moduleId} — état actuel des stocks en casier
 * (ce qui est PHYSIQUEMENT disponible maintenant, pas une préparation à la
 * demande) : c'est la source utilisée pour la boutique ("afficher ceux qui
 * sont en stock") et pour la réservation de casier à la commande. */
export async function fetchRealtimeCatalog(config: LockerSourceConfig): Promise<McfRealtimeProduct[]> {
  if (!config.moduleId) throw new LockerSourceError("Module Mon Casier Frais non configuré");
  const json = await mcfGet(config, `/catalog/realtime/${encodeURIComponent(config.moduleId)}`);
  return extractRows(json, "products");
}

/** Best-effort : le catalogue temps réel ne fournit ni catégorie lisible ni
 * image — enrichit via /v1/products (productTypeId, unitType) + un second
 * appel /v1/product-types pour résoudre le nom de la catégorie, et via
 * /v1/catalog/delivery/{moduleId} pour récupérer une miniature (même
 * format base64 que les photos saisies manuellement côté admin — cf.
 * admin.html rsAddPhotos). Un échec sur cet enrichissement ne bloque jamais
 * l'import : les produits retombent sur defaultCategory, sans image. */
async function enrichCatalog(
  config: LockerSourceConfig,
  productIds: string[]
): Promise<{ meta: Map<string, { category?: string; unitType?: string }>; images: Map<string, string> }> {
  const meta = new Map<string, { category?: string; unitType?: string }>();
  const images = new Map<string, string>();
  if (!productIds.length) return { meta, images };

  try {
    const q = encodeURIComponent(JSON.stringify({ id: { $in: productIds } }));
    const rows = extractRows(await mcfGet(config, `/products?q=${q}`), "products");
    const typeIds = Array.from(new Set(rows.map((r: any) => r.productTypeId).filter(Boolean)));
    const typeNames = new Map<string, string>();
    if (typeIds.length) {
      const q2 = encodeURIComponent(JSON.stringify({ id: { $in: typeIds } }));
      const rows2 = extractRows(await mcfGet(config, `/product-types?q=${q2}`), "product-types", "productTypes");
      rows2.forEach((t: any) => {
        if (t.id && t.name) typeNames.set(t.id, t.name);
      });
    }
    rows.forEach((r: any) => {
      if (r.id) meta.set(r.id, { category: r.productTypeId ? typeNames.get(r.productTypeId) : undefined, unitType: r.unitType });
    });
  } catch {
    // Non bloquant — l'import retombe sur defaultCategory.
  }

  try {
    if (config.moduleId) {
      const rows = extractRows(await mcfGet(config, `/catalog/delivery/${encodeURIComponent(config.moduleId)}`), "products");
      rows.forEach((r: any) => {
        if (r.id && typeof r.thumbnailBase64Data === "string" && r.thumbnailBase64Data.startsWith("data:")) {
          images.set(r.id, r.thumbnailBase64Data);
        }
      });
    }
  } catch {
    // Non bloquant — pas d'image, la boutique retombe sur l'icône par défaut.
  }

  return { meta, images };
}

/**
 * Importe le catalogue temps réel dans la boutique (table Product). Un
 * même produit source avec plusieurs conditionnements (ex : Comté AOP en
 * 0.5kg / 1kg) devient une ligne Product PAR conditionnement — chacun a son
 * propre stock et son propre prix, comme deux articles distincts en
 * boutique. externalId = "{productId}#{quantity}" identifie chaque ligne
 * de façon stable d'un sync à l'autre (upsert, jamais de doublon).
 *
 * Ne supprime jamais un produit disparu du catalogue source (pourrait être
 * référencé par une commande passée, dont Order.items garde de toute façon
 * un instantané figé) — le stock repasse simplement à 0, ce qui le masque
 * côté boutique client (cf. /roomservice/product/public) sans effacer
 * l'historique.
 */
export async function runCatalogImport(entity: Entity, config: LockerSourceConfig) {
  try {
    if (!config.moduleId) throw new LockerSourceError("Module Mon Casier Frais non configuré");
    const catalog = await fetchRealtimeCatalog(config);
    const { meta, images } = await enrichCatalog(
      config,
      catalog.map((p) => p.id)
    );

    let created = 0;
    let updated = 0;
    const seenExternalIds: string[] = [];

    for (const p of catalog) {
      const options: McfPackagingOption[] = p.packagingOptions?.length
        ? p.packagingOptions
        : [{ quantity: 1, lockers: [], totalAvailable: 0, price: p.price }];
      const multi = options.length > 1;
      const info = meta.get(p.id);
      const image = images.get(p.id);

      for (const opt of options) {
        const externalId = `${p.id}#${opt.quantity}`;
        seenExternalIds.push(externalId);
        const label = multi ? `${p.name} — ${opt.quantity}${info?.unitType ? " " + info.unitType : ""}` : p.name;

        const existing = await prisma.product.findUnique({
          where: { entityId_externalId: { entityId: entity.id, externalId } },
        });

        const data = {
          category: info?.category || config.defaultCategory || "Mon Casier Frais",
          label,
          description: p.description || null,
          price: (opt.price ?? p.price) / 100,
          importedFrom: "moncasierfrais",
          externalId,
          stockQty: opt.totalAvailable ?? 0,
          lockerLayout: (opt.lockers as unknown as object) ?? [],
          vatRate: p.VAT ?? null,
          ...(image ? { photo: image } : {}),
        };

        if (existing) {
          await prisma.product.update({ where: { id: existing.id }, data });
          updated++;
        } else {
          const maxOrder = await prisma.product.count({ where: { entityId: entity.id } });
          await prisma.product.create({
            data: { ...data, entityId: entity.id, active: true, sortOrder: maxOrder },
          });
          created++;
        }
      }
    }

    await prisma.product.updateMany({
      where: {
        entityId: entity.id,
        importedFrom: "moncasierfrais",
        externalId: { notIn: seenExternalIds.length ? seenExternalIds : ["__none__"] },
      },
      data: { stockQty: 0 },
    });

    const message = `${created} créé(s), ${updated} mis à jour`;
    await prisma.lockerSourceConfig.update({
      where: { id: config.id },
      data: { lastSyncAt: new Date(), lastSyncStatus: "success", lastSyncMessage: message, lastSyncCount: created + updated },
    });
    return { ok: true as const, created, updated };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Erreur inconnue";
    await prisma.lockerSourceConfig.update({
      where: { id: config.id },
      data: { lastSyncAt: new Date(), lastSyncStatus: "error", lastSyncMessage: message, lastSyncCount: null },
    });
    return { ok: false as const, message };
  }
}

export interface LockerReservationItem {
  product: Product;
  qty: number;
}

/**
 * Réserve, au moment de la commande, un casier par unité commandée pour
 * chaque article importé du panier. Revérifie le stock EN DIRECT auprès de
 * la source (jamais depuis le cache local Product.stockQty, potentiellement
 * périmé depuis le dernier sync) pour éviter de réserver un casier déjà
 * vidé. Best-effort : un échec ici ne doit jamais empêcher la création de
 * la commande locale (cf. appelant, roomservice.ts) — l'appelant décide de
 * ce qui se passe si ok=false.
 */
export async function reserveLockersForOrder(
  config: LockerSourceConfig,
  items: LockerReservationItem[],
  opts: { clientEmail: string; pickupCode: string; comments?: string }
): Promise<{ ok: boolean; lockerNumbers?: number[]; mcfOrderId?: string; error?: string }> {
  if (!config.enabled || !config.moduleId) return { ok: false, error: "Connecteur Mon Casier Frais non configuré" };

  let catalog: McfRealtimeProduct[];
  try {
    catalog = await fetchRealtimeCatalog(config);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const numbersNeeded: number[] = [];
  for (const { product, qty } of items) {
    if (!product.externalId) continue;
    const sep = product.externalId.lastIndexOf("#");
    const mcfProductId = sep >= 0 ? product.externalId.slice(0, sep) : product.externalId;
    const quantity = sep >= 0 ? Number(product.externalId.slice(sep + 1)) : undefined;
    const catProduct = catalog.find((p) => p.id === mcfProductId);
    const option = catProduct?.packagingOptions?.find((o) => o.quantity === quantity);
    const available = (option?.lockers || []).map((l) => l.numberOnModule);
    if (available.length < qty) {
      return {
        ok: false,
        error: `Stock insuffisant pour "${product.label}" (${available.length} disponible(s), ${qty} demandé(s))`,
      };
    }
    numbersNeeded.push(...available.slice(0, qty));
  }
  if (!numbersNeeded.length) return { ok: true, lockerNumbers: [] };

  let lockerRows: any[];
  try {
    const q = encodeURIComponent(
      JSON.stringify({ $and: [{ moduleId: config.moduleId }, { numberOnModule: { $in: numbersNeeded } }] })
    );
    lockerRows = extractRows(await mcfGet(config, `/lockers?q=${q}`), "lockers");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const idByNumber = new Map<number, string>();
  lockerRows.forEach((l: any) => {
    if (typeof l.numberOnModule === "number" && l.id) idByNumber.set(l.numberOnModule, l.id);
  });
  const lockerIds = numbersNeeded.map((n) => idByNumber.get(n)).filter((v): v is string => !!v);
  if (lockerIds.length !== numbersNeeded.length) {
    return { ok: false, error: "Certains casiers annoncés disponibles n'ont pas pu être identifiés (/v1/lockers)" };
  }

  const priceCents = Math.round(items.reduce((s, { product, qty }) => s + product.price * qty, 0) * 100);
  const vatRate = items.map(({ product }) => product.vatRate).find((v) => v != null);

  try {
    const json = await mcfPost(config, `/order/bookLockers/${encodeURIComponent(config.moduleId)}`, {
      name: `Sesame Suite — ${opts.pickupCode}`,
      code: opts.pickupCode,
      lockerIds,
      clientEmail: opts.clientEmail,
      isPaid: false,
      price: priceCents,
      ...(vatRate != null ? { VAT: vatRate } : {}),
      ...(opts.comments ? { comments: opts.comments } : {}),
    });
    return { ok: true, lockerNumbers: numbersNeeded, mcfOrderId: json?.orderId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Annulation best-effort d'une réservation de casier précédemment créée
 * (cf. Order.lockerSourceOrderId), déclenchée quand la commande locale est
 * annulée côté admin. Jamais bloquante pour l'annulation locale. */
export async function cancelLockerReservation(
  config: LockerSourceConfig,
  mcfOrderId: string,
  reason: string
): Promise<{ ok: boolean; error?: string }> {
  if (!config.moduleId) return { ok: false, error: "Module Mon Casier Frais non configuré" };
  try {
    await mcfPost(config, `/order/cancelOrder/${encodeURIComponent(config.moduleId)}`, { id: mcfOrderId, reason });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

interface McfLockerRow {
  id: string;
  lockerBlocId?: string;
  number?: number;
  numberOnModule: number;
  state?: number;
  moduleId?: string;
}

/** GET /v1/lockers filtré sur le module configuré — liste BRUTE de tous les
 * casiers physiques de l'installation (contrairement à
 * reserveLockersForOrder ci-dessus, qui ne récupère que les casiers
 * correspondant à une commande précise). Sert à importer les casiers comme
 * "accès" — cf. runLockerRoomImport. */
export async function fetchLockersForModule(config: LockerSourceConfig): Promise<McfLockerRow[]> {
  if (!config.moduleId) throw new LockerSourceError("Module Mon Casier Frais non configuré");
  const q = encodeURIComponent(JSON.stringify({ moduleId: config.moduleId }));
  const json = await mcfGet(config, `/lockers?q=${q}`);
  return extractRows(json, "lockers");
}

/**
 * Importe les casiers du module configuré comme "accès" (table Room, type
 * "casier") — panneau "Gestion des Accès". Contrairement au catalogue
 * boutique (runCatalogImport), c'est une action MANUELLE/PONCTUELLE,
 * jamais planifiée : les casiers physiques d'une installation changent
 * rarement, inutile de resynchroniser en tâche de fond (pas d'entrée dans
 * lockerSourceScheduler.ts pour ce flux). Idempotent par code
 * ("CASIER-{numberOnModule}") — un import répété ne crée jamais de
 * doublon ; un accès déjà présent n'est PAS retouché (l'admin a pu le
 * renommer, changer son étage/sa photo depuis), seuls les nouveaux casiers
 * détectés sont créés.
 */
export async function runLockerRoomImport(entity: Entity, config: LockerSourceConfig) {
  const lockers = await fetchLockersForModule(config);
  let created = 0;
  let skipped = 0;
  for (const l of lockers) {
    if (typeof l.numberOnModule !== "number") continue;
    const code = `CASIER-${l.numberOnModule}`;
    const existing = await prisma.room.findUnique({ where: { entityId_code: { entityId: entity.id, code } } });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.room.create({
      data: {
        entityId: entity.id,
        code,
        name: `Casier n°${l.numberOnModule}`,
        floor: 0,
        type: "casier",
        available: true,
        tags: [],
        photos: [],
      },
    });
    created++;
  }
  return { ok: true as const, created, skipped, total: lockers.length };
}
