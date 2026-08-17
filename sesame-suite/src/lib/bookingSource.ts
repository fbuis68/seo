import { prisma } from "../db";
import type { BookingSourceConfig, Entity } from "@prisma/client";
import { fireTrigger } from "./automation";

/** Champs Booking que le mapping peut renseigner — valeur = dot-path dans
 * chaque élément du tableau JSON retourné par la source externe. */
export interface FieldMapping {
  code?: string;
  personEmail?: string;
  personFirstname?: string;
  personLastname?: string;
  personPhone?: string;
  startDate?: string;
  endDate?: string;
  facilityCode?: string;
  status?: string;
}

export interface MappedBooking {
  code: string;
  personEmail: string;
  personFirstname: string;
  personLastname: string;
  personPhone: string;
  startDate: Date;
  endDate: Date;
  facilityCode: string;
  status: string;
}

export interface MapError {
  index: number;
  reason: string;
}

/** Champs Room que le mapping "facilities" peut renseigner. */
export interface FacilityMapping {
  code?: string;
  name?: string;
  floor?: string;
  category?: string;
  capacity?: string;
  surface?: string;
}

export interface MappedFacility {
  code: string;
  name: string;
  floor: number | null;
  category: string;
  capacity: number | null;
  surface: number | null;
}

/** Lecture d'un chemin "a.b.c" (ou "a.0.b" pour un index de tableau) dans un objet. */
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split(".").reduce<unknown>((cur, key) => {
    if (cur === null || cur === undefined) return undefined;
    return (cur as Record<string, unknown>)[key];
  }, obj);
}

export class BookingSourceError extends Error {}

/**
 * fetch() ne rejette qu'avec "fetch failed" — la vraie cause (DNS introuvable,
 * connexion refusée, certificat TLS invalide, timeout…) est dans `cause`,
 * caché par défaut. On la remonte explicitement pour que l'erreur affichée
 * dans le panneau "Intégration réservations" soit diagnosticable au lieu
 * d'un "fetch failed" muet.
 */
function describeFetchError(e: unknown): string {
  if (!(e instanceof Error)) return "erreur réseau";
  const cause = (e as { cause?: unknown }).cause;
  const causeCode = cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : null;
  const causeMessage = cause instanceof Error ? cause.message : null;
  if (causeCode === "ENOTFOUND") return `nom de domaine introuvable (DNS) — vérifiez l'URL de base`;
  if (causeCode === "ECONNREFUSED") return `connexion refusée par le serveur distant — vérifiez l'URL et le port`;
  if (causeCode === "ETIMEDOUT" || causeCode === "UND_ERR_CONNECT_TIMEOUT") return `délai de connexion dépassé — le serveur ne répond pas`;
  if (causeCode === "ECONNRESET") return `connexion interrompue par le serveur distant`;
  if (causeCode && /CERT|SSL|TLS/i.test(causeCode)) return `certificat TLS invalide (${causeCode})`;
  if (causeMessage) return `${e.message} — ${causeMessage}`;
  return e.message;
}

/** Parse le corps JSON d'une réponse ; sur échec, inclut un extrait du texte
 * brut reçu (page HTML, message d'erreur texte…) pour rendre l'erreur
 * diagnosticable au lieu d'un simple "pas du JSON". */
async function parseJsonResponse(res: Response, context: string): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.trim().slice(0, 200) || "(réponse vide)";
    throw new BookingSourceError(`${context} n'est pas un JSON valide — début de la réponse reçue : "${snippet}"`);
  }
}

/**
 * Flux "login" (ex : API Sesame Technology) — POST des identifiants vers
 * loginPath, extraction du token via loginTokenPath. Relancé à chaque appel
 * (pas de cache de token) : plus simple et plus sûr qu'une expiration mal
 * estimée, et les synchronisations restent peu fréquentes (≥1h).
 */
async function performLogin(config: BookingSourceConfig): Promise<string> {
  if (!config.baseUrl) throw new BookingSourceError("URL de base non configurée");
  if (!config.loginEmail || !config.loginPassword) throw new BookingSourceError("Email et mot de passe de connexion requis");

  const emailField = config.loginEmailField || "login";
  const passwordField = config.loginPasswordField || "password";
  const inQuery = (config.loginEmailLocation || "body") === "query";

  let url = config.baseUrl.replace(/\/$/, "") + (config.loginPath || "");
  if (inQuery) url += (url.includes("?") ? "&" : "?") + `${encodeURIComponent(emailField)}=${encodeURIComponent(config.loginEmail)}`;
  const body: Record<string, string> = { [passwordField]: config.loginPassword };
  if (!inQuery) body[emailField] = config.loginEmail;
  if (config.loginExtraField) body[config.loginExtraField] = config.loginExtraValue || "";

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      // Node/undici n'envoie aucun User-Agent par défaut (contrairement aux
      // navigateurs et à curl) — certains WAF/pare-feux applicatifs
      // bloquent ou redirigent silencieusement vers une page HTML par
      // défaut (souvent la page de login) les requêtes qui en sont
      // dépourvues, d'où l'ajout explicite ci-dessous.
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "SesameSuite-BookingConnector/1.0" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new BookingSourceError(`Connexion (login) impossible : ${describeFetchError(e)}`);
  }
  if (!res.ok) throw new BookingSourceError(`La connexion a échoué : ${res.status} ${res.statusText}`);

  const responseBody = await parseJsonResponse(res, "La réponse de connexion");

  let token: unknown;
  if (config.loginProfileListPath && config.loginProfileMatchField && config.loginProfileMatchValue) {
    // La réponse contient un tableau avec un profil par établissement (ex :
    // API Sesame Technology, un même compte a accès à plusieurs hôtels) —
    // on retrouve le bon profil par un champ (ex: entityCode) plutôt que de
    // dépendre de sa position dans le tableau, qui n'est pas garantie stable.
    const list = getPath(responseBody, config.loginProfileListPath);
    if (!Array.isArray(list)) {
      throw new BookingSourceError(`Le chemin "${config.loginProfileListPath}" ne pointe pas vers un tableau dans la réponse de connexion`);
    }
    const matchField = config.loginProfileMatchField;
    const profile = list.find(
      (item) => item && typeof item === "object" && String((item as Record<string, unknown>)[matchField]) === config.loginProfileMatchValue
    );
    if (!profile) {
      const available = list
        .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>)[matchField] : undefined))
        .filter((v) => v !== undefined && v !== "")
        .join(", ");
      throw new BookingSourceError(
        `Aucun profil avec ${matchField}="${config.loginProfileMatchValue}" trouvé dans "${config.loginProfileListPath}"` +
          (available ? ` (valeurs disponibles : ${available})` : "")
      );
    }
    token = getPath(profile, config.loginTokenPath || "token");
  } else {
    token = config.loginTokenPath ? getPath(responseBody, config.loginTokenPath) : undefined;
  }

  if (!token || typeof token !== "string") {
    throw new BookingSourceError(
      config.loginTokenPath
        ? `Aucun token trouvé au chemin "${config.loginTokenPath}" ${config.loginProfileListPath ? "dans le profil sélectionné" : "dans la réponse de connexion"}`
        : "Chemin du token de connexion non configuré"
    );
  }
  return token;
}

async function buildAuthHeaders(config: BookingSourceConfig): Promise<Record<string, string>> {
  switch (config.authType) {
    case "apiKey":
      if (!config.authApiKeyHeader || !config.authApiKeyValue) return {};
      return { [config.authApiKeyHeader]: config.authApiKeyValue };
    case "bearer":
      return config.authBearerToken ? { Authorization: `Bearer ${config.authBearerToken}` } : {};
    case "basic":
      if (!config.authBasicUser) return {};
      return { Authorization: "Basic " + Buffer.from(`${config.authBasicUser}:${config.authBasicPassword || ""}`).toString("base64") };
    case "login": {
      const token = await performLogin(config);
      const headerName = config.loginTokenHeaderName || "Authorization";
      return { [headerName]: (config.loginTokenPrefix || "") + token };
    }
    default:
      return {};
  }
}

/**
 * Appelle un endpoint de la source externe et renvoie le tableau brut trouvé.
 * La plupart des API répondent à un simple GET, mais certaines (ex : API
 * Sesame Technology, /wa/booking/list) exigent un POST avec un corps
 * application/x-www-form-urlencoded — souvent juste de la pagination
 * (start/limit) — d'où le méthode/paramètres configurables.
 */
async function fetchExternalList(
  config: BookingSourceConfig,
  endpointPath: string | null,
  responseListPath: string | null,
  what: string,
  method: string | null,
  bodyParams: unknown
): Promise<unknown[]> {
  if (!config.baseUrl) throw new BookingSourceError("URL de base non configurée");
  const url = config.baseUrl.replace(/\/$/, "") + (endpointPath || "");
  const authHeaders = await buildAuthHeaders(config);
  const isPost = (method || "GET").toUpperCase() === "POST";
  let res: Response;
  try {
    if (isPost) {
      const form = new URLSearchParams();
      if (bodyParams && typeof bodyParams === "object") {
        for (const [k, v] of Object.entries(bodyParams as Record<string, unknown>)) form.set(k, String(v));
      }
      res = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "SesameSuite-BookingConnector/1.0",
          ...authHeaders,
        },
        body: form.toString(),
      });
    } else {
      res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "SesameSuite-BookingConnector/1.0", ...authHeaders } });
    }
  } catch (e) {
    throw new BookingSourceError(`Connexion impossible : ${describeFetchError(e)}`);
  }
  if (!res.ok) throw new BookingSourceError(`Le serveur distant a répondu ${res.status} ${res.statusText}`);

  const body = await parseJsonResponse(res, "La réponse");

  const list = responseListPath ? getPath(body, responseListPath) : body;
  if (!Array.isArray(list)) {
    // Inclut un extrait de la réponse reçue (comme pour l'erreur "pas un JSON
    // valide") — sans ça, un chemin correct sur le papier mais qui échoue en
    // pratique (forme de réponse différente selon les paramètres envoyés,
    // erreur applicative renvoyée avec un statut 200...) est impossible à
    // diagnostiquer depuis ce seul message.
    const snippet = JSON.stringify(body).slice(0, 300);
    throw new BookingSourceError(
      (responseListPath
        ? `Le chemin "${responseListPath}" ne pointe pas vers un tableau`
        : `La réponse n'est pas un tableau — précisez le chemin vers la liste des ${what}`) + ` — réponse reçue : "${snippet}"`
    );
  }
  return list;
}

/** Appelle la source externe et renvoie le tableau brut de réservations (pas encore mappé). */
export async function fetchExternalBookings(config: BookingSourceConfig): Promise<unknown[]> {
  return fetchExternalList(config, config.endpointPath, config.responseListPath, "réservations", config.endpointMethod, config.endpointBodyParams);
}

/** Appelle la source externe et renvoie le tableau brut de chambres/facilities (pas encore mappé). */
export async function fetchExternalFacilities(config: BookingSourceConfig): Promise<unknown[]> {
  return fetchExternalList(
    config,
    config.facilityEndpointPath,
    config.facilityResponseListPath,
    "chambres",
    config.facilityEndpointMethod,
    config.facilityEndpointBodyParams
  );
}

/** Applique le mapping de champs à la liste brute — sépare éléments valides et en erreur. */
export function mapBookings(items: unknown[], mapping: FieldMapping): { mapped: MappedBooking[]; errors: MapError[] } {
  const mapped: MappedBooking[] = [];
  const errors: MapError[] = [];

  items.forEach((item, index) => {
    const code = mapping.code ? String(getPath(item, mapping.code) ?? "").trim() : "";
    const personEmail = mapping.personEmail ? String(getPath(item, mapping.personEmail) ?? "").trim() : "";
    const startRaw = mapping.startDate ? getPath(item, mapping.startDate) : undefined;
    const endRaw = mapping.endDate ? getPath(item, mapping.endDate) : undefined;

    if (!code) { errors.push({ index, reason: "code de réservation manquant" }); return; }
    if (!personEmail) { errors.push({ index, reason: "email client manquant" }); return; }
    const startDate = startRaw ? new Date(String(startRaw)) : null;
    const endDate = endRaw ? new Date(String(endRaw)) : null;
    if (!startDate || isNaN(startDate.getTime())) { errors.push({ index, reason: "date d'arrivée invalide ou manquante" }); return; }
    if (!endDate || isNaN(endDate.getTime())) { errors.push({ index, reason: "date de départ invalide ou manquante" }); return; }

    mapped.push({
      code,
      personEmail,
      personFirstname: mapping.personFirstname ? String(getPath(item, mapping.personFirstname) ?? "").trim() : "",
      personLastname: mapping.personLastname ? String(getPath(item, mapping.personLastname) ?? "").trim() : "",
      personPhone: mapping.personPhone ? String(getPath(item, mapping.personPhone) ?? "").trim() : "",
      startDate,
      endDate,
      facilityCode: mapping.facilityCode ? String(getPath(item, mapping.facilityCode) ?? "").trim() : "",
      status: (mapping.status ? String(getPath(item, mapping.status) ?? "").trim() : "") || "confirmed",
    });
  });

  return { mapped, errors };
}

/** Applique le mapping de champs à la liste brute de chambres — sépare éléments valides et en erreur. */
export function mapFacilities(items: unknown[], mapping: FacilityMapping): { mapped: MappedFacility[]; errors: MapError[] } {
  const mapped: MappedFacility[] = [];
  const errors: MapError[] = [];

  const toNum = (v: unknown): number | null => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  };

  items.forEach((item, index) => {
    const code = mapping.code ? String(getPath(item, mapping.code) ?? "").trim() : "";
    if (!code) { errors.push({ index, reason: "code de chambre manquant" }); return; }

    mapped.push({
      code,
      name: mapping.name ? String(getPath(item, mapping.name) ?? "").trim() || code : code,
      floor: mapping.floor ? toNum(getPath(item, mapping.floor)) : null,
      category: mapping.category ? String(getPath(item, mapping.category) ?? "").trim() : "",
      capacity: mapping.capacity ? toNum(getPath(item, mapping.capacity)) : null,
      surface: mapping.surface ? toNum(getPath(item, mapping.surface)) : null,
    });
  });

  return { mapped, errors };
}

/** Crée/met à jour les chambres mappées (upsert par entityId+code) — cf. panneau "Gestion des chambres". */
export async function upsertMappedFacilities(entity: Entity, mapped: MappedFacility[]) {
  let created = 0;
  let updated = 0;
  for (const f of mapped) {
    const existing = await prisma.room.findUnique({ where: { entityId_code: { entityId: entity.id, code: f.code } } });
    const data = {
      name: f.name,
      floor: f.floor ?? undefined,
      category: f.category || undefined,
      capacity: f.capacity ?? undefined,
      surface: f.surface ?? undefined,
    };
    if (existing) {
      await prisma.room.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.room.create({ data: { entityId: entity.id, code: f.code, tags: [], photos: [], ...data } });
      created++;
    }
  }
  return { created, updated };
}

/** Crée/met à jour les réservations mappées (upsert par entityId+code). */
export async function upsertMappedBookings(entity: Entity, mapped: MappedBooking[], sourceName: string) {
  let created = 0;
  let updated = 0;
  for (const b of mapped) {
    const room = b.facilityCode
      ? await prisma.room.findUnique({ where: { entityId_code: { entityId: entity.id, code: b.facilityCode } } })
      : null;
    const existing = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code: b.code } } });
    const data = {
      personEmail: b.personEmail,
      personFirstname: b.personFirstname || existing?.personFirstname || "",
      personLastname: b.personLastname || existing?.personLastname || "",
      personPhone: b.personPhone || undefined,
      startDate: b.startDate,
      endDate: b.endDate,
      facilityCode: b.facilityCode || undefined,
      facilityName: room?.name || undefined,
      roomId: room?.id,
      status: b.status,
      importedFrom: sourceName,
    };
    if (existing) {
      await prisma.booking.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      const row = await prisma.booking.create({ data: { entityId: entity.id, code: b.code, ...data } });
      created++;
      fireTrigger("booking.created", {
        entityId: entity.id,
        targetType: "booking",
        targetId: row.id,
        recipient: { email: row.personEmail, phone: row.personPhone },
        variables: { prenom: row.personFirstname, nom: row.personLastname, code: row.code },
      }).catch((e) => console.error("[automation] booking.created:", e));
    }
  }
  return { created, updated };
}

/** Exécute une synchronisation complète pour un établissement — utilisé par
 * l'import manuel (POST /wa/bookingSource/import) et le planificateur. */
export async function runImport(entity: Entity, config: BookingSourceConfig) {
  const mapping = (config.fieldMapping as FieldMapping | null) || {};
  const sourceName = config.sourceName || "Connecteur externe";
  try {
    const raw = await fetchExternalBookings(config);
    const { mapped, errors } = mapBookings(raw, mapping);
    const { created, updated } = await upsertMappedBookings(entity, mapped, sourceName);
    const message = `${created} créée(s), ${updated} mise(s) à jour${errors.length ? `, ${errors.length} ignorée(s)` : ""}`;
    await prisma.bookingSourceConfig.update({
      where: { id: config.id },
      data: { lastSyncAt: new Date(), lastSyncStatus: "success", lastSyncMessage: message, lastSyncCount: created + updated },
    });
    return { ok: true as const, created, updated, errors, total: raw.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Erreur inconnue";
    await prisma.bookingSourceConfig.update({
      where: { id: config.id },
      data: { lastSyncAt: new Date(), lastSyncStatus: "error", lastSyncMessage: message, lastSyncCount: null },
    });
    return { ok: false as const, message };
  }
}
