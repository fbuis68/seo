import { prisma } from "../db";
import type { BookingSourceConfig, Entity } from "@prisma/client";
import { fireTrigger } from "./automation";

/** L'admin accepte de saisir "sesame.technology" sans schéma — `fetch()`
 * échoue alors avec "Failed to parse URL … Invalid URL", un message qui ne
 * pointe pas vers la vraie cause. On complète par https:// par défaut. */
function normalizeBaseUrl(baseUrl: string): string {
  return /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
}

const CONNECTOR_TIMEOUT_MS = 15000;

/** Tous les appels sortants vers une source externe passent par ici plutôt
 * que par `fetch()` nu — sans limite de temps, une source lente ou qui ne
 * répond jamais laisse la requête bloquée indéfiniment, et avec elle le
 * bouton côté client qui l'a déclenchée (constaté en pratique : "Ouvrir la
 * porte" resté grisé sans aucun message, 25/08/2026). */
function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(CONNECTOR_TIMEOUT_MS) });
}

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
  // Optionnel — certaines sources (ex : API Sesame Technology) renvoient déjà
  // le nom/libellé de la chambre directement dans la réservation (ex :
  // "Chambre 3"), sans avoir besoin d'importer les chambres séparément via
  // la section "Chambres (facilities)". Utilisé si renseigné, sinon repli
  // sur le nom de la chambre importée correspondant à facilityCode.
  facilityName?: string;
  status?: string;
  // Champ à part entière côté source (ex : "typeCode"/"typeId"/"type" de
  // l'API Sesame Technology) — distinct du type/catégorie de la chambre
  // occupée (Room.category), qui a son propre mapping (facilityCode ->
  // chambre importée).
  bookingType?: string;
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
  facilityName: string;
  status: string;
  bookingType: string;
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
  // Certaines sources (ex : API Sesame Technology) renvoient dans la même
  // liste les vraies chambres ET d'autres accès (espaces communs,
  // bagagerie, entrée principale…) — sans filtre, ceux-ci seraient importés
  // comme de fausses chambres. Liste de valeurs de "category" (issu du
  // mapping ci-dessus) à exclure de l'import, séparées par une virgule —
  // comparaison insensible à la casse. Optionnel : sans category mappé ou
  // sans valeur ici, rien n'est filtré.
  excludeCategories?: string;
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
  if (e.name === "TimeoutError") return `délai de ${CONNECTOR_TIMEOUT_MS / 1000}s dépassé sans réponse du serveur distant`;
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
 * Extrait les cookies "Set-Cookie" d'une réponse en un en-tête "Cookie:" prêt
 * à renvoyer (ex : "JSESSIONID=abc; autre=xyz") — certains systèmes (ex :
 * portail Sesame Technology) authentifient les appels suivants par cookie de
 * session plutôt que (ou en plus) par le token renvoyé dans le corps JSON.
 * `Headers.get("set-cookie")` fusionne plusieurs en-têtes avec ", ", ce qui
 * casse le format des cookies (leur date d'expiration contient des virgules)
 * — on utilise `getSetCookie()` (disponible sur le fetch de Node) quand elle
 * existe, sinon on se rabat sur `get()` (suffisant s'il n'y a qu'un cookie).
 */
function extractCookieHeader(res: Response): string | undefined {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const raw = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : (() => {
    const single = res.headers.get("set-cookie");
    return single ? [single] : [];
  })();
  const pairs = raw.map((c) => c.split(";")[0].trim()).filter(Boolean);
  return pairs.length ? pairs.join("; ") : undefined;
}

/**
 * Flux "login" (ex : API Sesame Technology) — POST des identifiants vers
 * loginPath, extraction du token via loginTokenPath. Relancé à chaque appel
 * (pas de cache de token) : plus simple et plus sûr qu'une expiration mal
 * estimée, et les synchronisations restent peu fréquentes (≥1h). Renvoie
 * aussi le cookie de session éventuellement posé par la réponse de connexion
 * (cf. extractCookieHeader), à renvoyer sur les appels suivants pour les
 * systèmes qui authentifient par session plutôt que par token.
 */
async function performLogin(
  config: BookingSourceConfig
): Promise<{ token: string; cookie?: string; resultFilterValue?: string; resultEntityField?: string }> {
  if (!config.baseUrl) throw new BookingSourceError("URL de base non configurée");
  if (!config.loginEmail || !config.loginPassword) throw new BookingSourceError("Identifiant et secret de connexion requis");

  const emailField = config.loginEmailField || "login";
  const passwordField = config.loginPasswordField || "password";
  const inQuery = (config.loginEmailLocation || "body") === "query";
  const useBasicHeader = config.loginCredentialsIn === "basicHeader";
  const bodyFormat = config.loginBodyFormat || "json";

  // loginPath accepte une URL absolue (le serveur d'authentification OAuth2
  // vit parfois sur un autre hôte que baseUrl, ex : Apaleo — identity.apaleo.com
  // vs api.apaleo.com) ; sinon concaténé à baseUrl comme les autres endpoints.
  const isAbsolute = /^https?:\/\//i.test(config.loginPath || "");
  let url = isAbsolute ? (config.loginPath as string) : normalizeBaseUrl(config.baseUrl).replace(/\/$/, "") + (config.loginPath || "");
  if (inQuery && !useBasicHeader) url += (url.includes("?") ? "&" : "?") + `${encodeURIComponent(emailField)}=${encodeURIComponent(config.loginEmail)}`;

  const body: Record<string, string> = {};
  if (!useBasicHeader) {
    body[passwordField] = config.loginPassword;
    if (!inQuery) body[emailField] = config.loginEmail;
  }
  if (config.loginExtraField) body[config.loginExtraField] = config.loginExtraValue || "";
  const extraParams = config.loginExtraParams && typeof config.loginExtraParams === "object" ? (config.loginExtraParams as Record<string, string>) : {};
  for (const [k, v] of Object.entries(extraParams)) {
    if (k) body[k] = v ?? "";
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    // Node/undici n'envoie aucun User-Agent par défaut (contrairement aux
    // navigateurs et à curl) — certains WAF/pare-feux applicatifs bloquent
    // ou redirigent silencieusement vers une page HTML par défaut (souvent
    // la page de login) les requêtes qui en sont dépourvues, d'où l'ajout
    // explicite ci-dessous.
    "User-Agent": "SesameSuite-BookingConnector/1.0",
  };
  if (useBasicHeader) {
    headers.Authorization = "Basic " + Buffer.from(`${config.loginEmail}:${config.loginPassword}`).toString("base64");
  }

  const hasBody = Object.keys(body).length > 0;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        ...headers,
        ...(hasBody ? { "Content-Type": bodyFormat === "form" ? "application/x-www-form-urlencoded" : "application/json" } : {}),
      },
      ...(hasBody ? { body: bodyFormat === "form" ? new URLSearchParams(body).toString() : JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new BookingSourceError(`Connexion (login) impossible : ${describeFetchError(e)}`);
  }
  if (!res.ok) throw new BookingSourceError(`La connexion a échoué : ${res.status} ${res.statusText}`);

  const cookie = extractCookieHeader(res);
  const responseBody = await parseJsonResponse(res, "La réponse de connexion");

  let token: unknown;
  let resultFilterValue: string | undefined;
  let resultEntityField: string | undefined;
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
    // Filtre anti-fuite inter-établissements — ACTIVÉ PAR DÉFAUT dès qu'un
    // tableau de profils est utilisé (sauf skipEntityFilter explicite) :
    // certaines API "login" à profils multiples (ex : un compte a accès à
    // des dizaines d'établissements) n'appliquent PAS de cloisonnement
    // strict par profil/token sur leurs autres endpoints — le token
    // authentifie le COMPTE, pas un établissement précis — et il a été
    // observé en pratique que des endpoints de liste renvoient des données
    // d'autres établissements que celui sélectionné ici (ex : réservations
    // "Le Victor" reçues sur le connecteur de l'établissement "Deer Forest",
    // configuré avant que ce filtre existe et jamais mis à jour depuis — ce
    // filtre était alors optionnel et cette fuite est passée inaperçue).
    // resultEntityField/resultEntityProfileField valent "entityId" si
    // laissés vides plutôt que de désactiver silencieusement le filtrage.
    if (!config.skipEntityFilter) {
      resultEntityField = config.resultEntityField || "entityId";
      const profileFieldPath = config.resultEntityProfileField || "entityId";
      const idRaw = getPath(profile, profileFieldPath);
      if (typeof idRaw !== "string" || !idRaw) {
        // Impossible de déterminer la valeur à filtrer — échouer bruyamment
        // plutôt qu'importer sans filtrer, ce qui mélangerait silencieusement
        // les données de plusieurs établissements. L'admin peut désactiver
        // ce filtre explicitement (skipEntityFilter) si la source est déjà
        // correctement cloisonnée par ailleurs.
        throw new BookingSourceError(
          `Filtrage anti-fuite inter-établissements (activé par défaut avec un tableau de profils) : aucune valeur trouvée au chemin "${profileFieldPath}" dans le profil sélectionné — synchronisation annulée pour éviter d'importer des données d'un autre établissement. Vérifiez "resultEntityProfileField", ou désactivez ce filtre (skipEntityFilter) si cette source ne renvoie déjà que les données du bon établissement.`
        );
      }
      resultFilterValue = idRaw;
    }
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
  return { token, cookie, resultFilterValue, resultEntityField };
}

async function buildAuthHeaders(
  config: BookingSourceConfig
): Promise<{ headers: Record<string, string>; resultFilterValue?: string; resultEntityField?: string }> {
  switch (config.authType) {
    case "apiKey":
      if (!config.authApiKeyHeader || !config.authApiKeyValue) return { headers: {} };
      return { headers: { [config.authApiKeyHeader]: config.authApiKeyValue } };
    case "bearer":
      return { headers: config.authBearerToken ? { Authorization: `Bearer ${config.authBearerToken}` } : {} };
    case "basic":
      if (!config.authBasicUser) return { headers: {} };
      return { headers: { Authorization: "Basic " + Buffer.from(`${config.authBasicUser}:${config.authBasicPassword || ""}`).toString("base64") } };
    case "login": {
      const { token, cookie, resultFilterValue, resultEntityField } = await performLogin(config);
      const headerName = config.loginTokenHeaderName || "Authorization";
      return {
        headers: {
          [headerName]: (config.loginTokenPrefix || "") + token,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        resultFilterValue,
        resultEntityField,
      };
    }
    default:
      return { headers: {} };
  }
}

/**
 * Appelle un endpoint de la source externe et renvoie le tableau brut trouvé.
 * La plupart des API répondent à un simple GET, mais certaines exigent un
 * POST avec un corps — soit application/x-www-form-urlencoded (ex : API
 * Sesame Technology, /wa/booking/list, souvent juste de la pagination
 * start/limit), soit un corps JSON (ex : API Mews, dont l'authentification
 * par ClientToken/AccessToken se fait dans le corps de chaque appel plutôt
 * que via un en-tête ou un jeton) — d'où méthode/format/paramètres
 * configurables.
 */
async function fetchExternalList(
  config: BookingSourceConfig,
  endpointPath: string | null,
  responseListPath: string | null,
  what: string,
  method: string | null,
  bodyFormat: string | null,
  bodyParams: unknown
): Promise<unknown[]> {
  if (!config.baseUrl) throw new BookingSourceError("URL de base non configurée");
  const url = normalizeBaseUrl(config.baseUrl).replace(/\/$/, "") + (endpointPath || "");
  const { headers: authHeaders, resultFilterValue, resultEntityField } = await buildAuthHeaders(config);
  const isPost = (method || "GET").toUpperCase() === "POST";
  const params: Record<string, unknown> = bodyParams && typeof bodyParams === "object" ? (bodyParams as Record<string, unknown>) : {};
  let res: Response;
  try {
    if (isPost && (bodyFormat || "form") === "json") {
      res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "SesameSuite-BookingConnector/1.0",
          ...authHeaders,
        },
        body: JSON.stringify(params),
      });
    } else if (isPost) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) form.set(k, String(v));
      res = await fetchWithTimeout(url, {
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
      res = await fetchWithTimeout(url, { headers: { Accept: "application/json", "User-Agent": "SesameSuite-BookingConnector/1.0", ...authHeaders } });
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

  // Filtre de sécurité anti-fuite inter-établissements — ACTIVÉ PAR DÉFAUT
  // avec le mode de connexion à profils (cf. performLogin), résolu là-bas
  // en `resultEntityField`/`resultFilterValue` (ou absents si
  // skipEntityFilter est explicitement activé). Certaines API "login" à
  // profils multiples n'appliquent pas de cloisonnement strict par profil
  // sur tous leurs endpoints : le token authentifie le COMPTE (qui peut
  // avoir accès à des dizaines d'établissements), pas nécessairement
  // l'établissement sélectionné à la connexion — confirmé en pratique,
  // /wa/booking/list a renvoyé des réservations d'un autre établissement
  // que celui authentifié.
  const filtered =
    resultEntityField && resultFilterValue
      ? list.filter((item) => String(getPath(item, resultEntityField)) === resultFilterValue)
      : list;
  return filtered;
}

/** Appelle la source externe et renvoie le tableau brut de réservations (pas encore mappé). */
export async function fetchExternalBookings(config: BookingSourceConfig): Promise<unknown[]> {
  return fetchExternalList(
    config,
    config.endpointPath,
    config.responseListPath,
    "réservations",
    config.endpointMethod,
    config.endpointBodyFormat,
    config.endpointBodyParams
  );
}

/** Appelle la source externe et renvoie le tableau brut de chambres/facilities (pas encore mappé). */
export async function fetchExternalFacilities(config: BookingSourceConfig): Promise<unknown[]> {
  return fetchExternalList(
    config,
    config.facilityEndpointPath,
    config.facilityResponseListPath,
    "chambres",
    config.facilityEndpointMethod,
    config.facilityEndpointBodyFormat,
    config.facilityEndpointBodyParams
  );
}

/**
 * Certaines sources (ex : API Sesame Technology) renvoient un seul
 * enregistrement pour une réservation de groupe (plusieurs chambres/
 * occupants liés) avec ces champs concaténés par une virgule (ex :
 * personEmail = "a@x.com,b@y.com", facilityCode = "CH1,CH1") — notre
 * schéma ne modélise qu'un occupant et une chambre par réservation, donc on
 * ne garde que la première valeur plutôt que d'importer une chaîne agrégée
 * invalide (ex : un "email" qui n'en est pas un).
 */
function firstOf(value: string): string {
  return value.split(",")[0].trim();
}

/**
 * Cas différent de firstOf() : pour facilityCode spécifiquement, une valeur
 * séparée par des virgules peut légitimement désigner PLUSIEURS accès
 * distincts pour UNE seule réservation (ex : "201,203" — porte de chambre +
 * accès commun, cf. doc officielle Sesame "Booking Creation", reprise telle
 * quelle par openAs) — la tronquer à la première valeur comme pour les
 * champs "personne" (cf. firstOf) supprimerait silencieusement les autres
 * serrures associées par la source. On ne dédoublonne que les valeurs
 * strictement identiques (le cas visé par le commentaire de firstOf : une
 * réservation de groupe où plusieurs personnes partagent la même chambre,
 * ex : "CH1,CH1").
 */
function dedupeFacilityCodes(value: string): string {
  const codes = value.split(",").map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  return codes.filter((c) => (seen.has(c) ? false : (seen.add(c), true))).join(",");
}

/** Applique le mapping de champs à la liste brute — sépare éléments valides et en erreur. */
export function mapBookings(items: unknown[], mapping: FieldMapping): { mapped: MappedBooking[]; errors: MapError[] } {
  const mapped: MappedBooking[] = [];
  const errors: MapError[] = [];

  items.forEach((item, index) => {
    const code = mapping.code ? String(getPath(item, mapping.code) ?? "").trim() : "";
    const personEmail = mapping.personEmail ? firstOf(String(getPath(item, mapping.personEmail) ?? "")) : "";
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
      personFirstname: mapping.personFirstname ? firstOf(String(getPath(item, mapping.personFirstname) ?? "")) : "",
      personLastname: mapping.personLastname ? firstOf(String(getPath(item, mapping.personLastname) ?? "")) : "",
      personPhone: mapping.personPhone ? firstOf(String(getPath(item, mapping.personPhone) ?? "")) : "",
      startDate,
      endDate,
      facilityCode: mapping.facilityCode ? dedupeFacilityCodes(String(getPath(item, mapping.facilityCode) ?? "")) : "",
      facilityName: mapping.facilityName ? firstOf(String(getPath(item, mapping.facilityName) ?? "")) : "",
      status: (mapping.status ? String(getPath(item, mapping.status) ?? "").trim() : "") || "confirmed",
      bookingType: mapping.bookingType ? String(getPath(item, mapping.bookingType) ?? "").trim() : "",
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

  const excluded = (mapping.excludeCategories || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  items.forEach((item, index) => {
    const code = mapping.code ? String(getPath(item, mapping.code) ?? "").trim() : "";
    if (!code) { errors.push({ index, reason: "code de chambre manquant" }); return; }

    const category = mapping.category ? String(getPath(item, mapping.category) ?? "").trim() : "";
    if (excluded.length && excluded.includes(category.toLowerCase())) {
      errors.push({ index, reason: `catégorie exclue ("${category}")` });
      return;
    }

    mapped.push({
      code,
      name: mapping.name ? String(getPath(item, mapping.name) ?? "").trim() || code : code,
      floor: mapping.floor ? toNum(getPath(item, mapping.floor)) : null,
      category,
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
    // b.facilityCode peut désormais lister plusieurs accès ("201,203") — Room
    // reste à une seule chambre, donc on ne cherche que sur le premier code
    // (celui affiché comme chambre principale de la réservation).
    const primaryFacilityCode = b.facilityCode ? firstOf(b.facilityCode) : "";
    const room = primaryFacilityCode
      ? await prisma.room.findUnique({ where: { entityId_code: { entityId: entity.id, code: primaryFacilityCode } } })
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
      // Priorité au nom fourni directement par la source (ex: API Sesame,
      // qui renvoie "Chambre 3" dans la réservation elle-même) — sinon repli
      // sur le nom de la chambre importée séparément via "Chambres".
      facilityName: b.facilityName || room?.name || undefined,
      roomId: room?.id,
      status: b.status,
      bookingType: b.bookingType || existing?.bookingType || undefined,
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

/**
 * Déclenche l'encodage d'une carte/badge NFC pour UNE réservation auprès de
 * la source externe (même connexion/auth que la synchronisation des
 * réservations, cf. buildAuthHeaders), via l'endpoint dédié
 * config.nfcEndpointPath. Inerte tant que ce champ n'est pas configuré —
 * échoue explicitement plutôt que de tenter un appel sur une URL vide.
 */
export async function encodeNfc(config: BookingSourceConfig, bookingCode: string): Promise<{ count: number }> {
  if (!config.nfcEndpointPath) {
    throw new BookingSourceError(
      'Encodage NFC non configuré pour cet établissement — renseignez "Encodage NFC" dans les réglages techniques avancés de l\'Intégration réservations (chemin d\'endpoint côté source externe).'
    );
  }
  if (!config.baseUrl) throw new BookingSourceError("URL de base non configurée");
  const url = normalizeBaseUrl(config.baseUrl).replace(/\/$/, "") + config.nfcEndpointPath;
  const { headers: authHeaders } = await buildAuthHeaders(config);
  const codeParam = config.nfcCodeParam || "code";
  const method = (config.nfcEndpointMethod || "POST").toUpperCase();
  const staticParams: Record<string, unknown> =
    config.nfcEndpointBodyParams && typeof config.nfcEndpointBodyParams === "object" ? (config.nfcEndpointBodyParams as Record<string, unknown>) : {};

  let res: Response;
  try {
    if (method === "GET") {
      const qs = new URLSearchParams();
      Object.entries(staticParams).forEach(([k, v]) => qs.set(k, String(v)));
      qs.set(codeParam, bookingCode);
      res = await fetchWithTimeout(`${url}${url.includes("?") ? "&" : "?"}${qs.toString()}`, {
        headers: { Accept: "application/json", "User-Agent": "SesameSuite-BookingConnector/1.0", ...authHeaders },
      });
    } else if ((config.nfcEndpointBodyFormat || "json") === "json") {
      res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "SesameSuite-BookingConnector/1.0",
          ...authHeaders,
        },
        body: JSON.stringify({ ...staticParams, [codeParam]: bookingCode }),
      });
    } else {
      const form = new URLSearchParams();
      Object.entries(staticParams).forEach(([k, v]) => form.set(k, String(v)));
      form.set(codeParam, bookingCode);
      res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "SesameSuite-BookingConnector/1.0",
          ...authHeaders,
        },
        body: form.toString(),
      });
    }
  } catch (e) {
    throw new BookingSourceError(`Connexion à l'encodeur NFC impossible : ${describeFetchError(e)}`);
  }
  if (!res.ok) throw new BookingSourceError(`L'encodeur NFC a répondu ${res.status} ${res.statusText}`);

  let count = 1;
  if (config.nfcResponseCountPath) {
    const body = await parseJsonResponse(res, "La réponse de l'encodeur NFC");
    const raw = getPath(body, config.nfcResponseCountPath);
    const n = Number(raw);
    if (!isNaN(n)) count = n;
  }
  return { count };
}

/**
 * Répercute un changement de chambre et/ou de statut (annulation/
 * réactivation) sur la source externe, via l'endpoint dédié
 * config.updateEndpointPath — panneau "Réservations" (bouton "Modifier",
 * changement de chambre ; bouton "Désactiver"/"Réactiver").
 *
 * Contrairement à encodeNfc/fetchAccessQr/openDoor (des actions explicites
 * déclenchées par un clic, où "non configuré" est une vraie erreur à
 * remonter), une mise à jour de réservation reste une opération LOCALE
 * valide même sans connecteur — ne lève donc jamais : silencieuse tant que
 * updateEndpointPath n'est pas configuré (retourne skipped:true), et
 * retourne ok:false + un message explicite en cas d'échec de l'appel
 * plutôt que de faire échouer toute la requête /booking/update. La
 * réservation locale (source de vérité de l'app) est toujours mise à jour
 * par l'appelant, que cet appel réussisse, échoue, ou soit sauté.
 */
export async function pushBookingUpdate(
  config: BookingSourceConfig,
  bookingCode: string,
  changes: { roomCode?: string | null; status?: string; bookingType?: string | null; startDate?: string | null; endDate?: string | null }
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  if (!config.updateEndpointPath) return { ok: true, skipped: true };
  if (!config.baseUrl) return { ok: false, error: "URL de base non configurée" };

  const params: Record<string, unknown> = {};
  if (changes.roomCode !== undefined && config.updateRoomParam) params[config.updateRoomParam] = changes.roomCode ?? "";
  if (changes.bookingType !== undefined && config.updateBookingTypeParam) params[config.updateBookingTypeParam] = changes.bookingType ?? "";
  if (changes.startDate !== undefined && config.updateStartDateParam) params[config.updateStartDateParam] = changes.startDate ?? "";
  if (changes.endDate !== undefined && config.updateEndDateParam) params[config.updateEndDateParam] = changes.endDate ?? "";
  if (changes.status !== undefined && config.updateStatusParam) {
    // Le vocabulaire de statut local (confirmed/checkin_done/completed/
    // cancelled) ne correspond pas forcément à celui de la source — ex :
    // l'API Sesame Technology attend "confirmed"/"checkedin"/"checkedout"/
    // "cancel". Traduit via updateStatusValueMap si une entrée existe,
    // sinon envoie la valeur locale telle quelle.
    const statusMap =
      config.updateStatusValueMap && typeof config.updateStatusValueMap === "object"
        ? (config.updateStatusValueMap as Record<string, string>)
        : {};
    params[config.updateStatusParam] = statusMap[changes.status] ?? changes.status;
  }
  if (!Object.keys(params).length) return { ok: true, skipped: true };

  const url = normalizeBaseUrl(config.baseUrl).replace(/\/$/, "") + config.updateEndpointPath;
  const { headers: authHeaders } = await buildAuthHeaders(config);
  const codeParam = config.updateCodeParam || "code";
  const method = (config.updateEndpointMethod || "POST").toUpperCase();
  const staticParams: Record<string, unknown> =
    config.updateEndpointBodyParams && typeof config.updateEndpointBodyParams === "object"
      ? (config.updateEndpointBodyParams as Record<string, unknown>)
      : {};

  let res: Response;
  try {
    if (method === "GET") {
      const qs = new URLSearchParams();
      Object.entries(staticParams).forEach(([k, v]) => qs.set(k, String(v)));
      Object.entries(params).forEach(([k, v]) => qs.set(k, String(v)));
      qs.set(codeParam, bookingCode);
      res = await fetchWithTimeout(`${url}${url.includes("?") ? "&" : "?"}${qs.toString()}`, {
        headers: { Accept: "application/json", "User-Agent": "SesameSuite-BookingConnector/1.0", ...authHeaders },
      });
    } else if ((config.updateEndpointBodyFormat || "json") === "json") {
      res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "SesameSuite-BookingConnector/1.0",
          ...authHeaders,
        },
        body: JSON.stringify({ ...staticParams, ...params, [codeParam]: bookingCode }),
      });
    } else {
      const form = new URLSearchParams();
      Object.entries(staticParams).forEach(([k, v]) => form.set(k, String(v)));
      Object.entries(params).forEach(([k, v]) => form.set(k, String(v)));
      form.set(codeParam, bookingCode);
      res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "SesameSuite-BookingConnector/1.0",
          ...authHeaders,
        },
        body: form.toString(),
      });
    }
  } catch (e) {
    return { ok: false, error: `Connexion à la source externe impossible : ${describeFetchError(e)}` };
  }
  if (!res.ok) return { ok: false, error: `La source externe a répondu ${res.status} ${res.statusText}` };
  return { ok: true };
}

/**
 * Récupère le QR code / code d'accès généré par la source externe pour UNE
 * réservation, via l'endpoint dédié config.qrEndpointPath. Inerte tant que
 * ce champ n'est pas configuré (l'appelant décide alors du repli — cf.
 * routes/booking.ts, qui bascule sur le mode simulation côté client plutôt
 * que d'appeler cette fonction).
 */
export async function fetchAccessQr(
  config: BookingSourceConfig,
  bookingCode: string,
  personEmail?: string | null
): Promise<{ qrImage?: string; qrValue?: string; accessCode?: string; validUntil?: string }> {
  if (!config.qrEndpointPath) {
    throw new BookingSourceError(
      'Récupération du QR code non configurée pour cet établissement — renseignez "Récupération QR / code d\'accès" dans les réglages techniques avancés de l\'Intégration réservations.'
    );
  }
  if (!config.baseUrl) throw new BookingSourceError("URL de base non configurée");
  const url = normalizeBaseUrl(config.baseUrl).replace(/\/$/, "") + config.qrEndpointPath;
  const { headers: authHeaders } = await buildAuthHeaders(config);
  const codeParam = config.qrCodeParam || "code";
  const method = (config.qrEndpointMethod || "GET").toUpperCase();
  const staticParams: Record<string, unknown> =
    config.qrEndpointBodyParams && typeof config.qrEndpointBodyParams === "object" ? (config.qrEndpointBodyParams as Record<string, unknown>) : {};
  // Certaines sources (ex : API Sesame Technology, /ws/pass/findMimeSecret)
  // exigent un second identifiant en plus du code de réservation — cf.
  // schema.prisma, qrEmailParam.
  const dynamicParams: Record<string, unknown> = { ...staticParams, [codeParam]: bookingCode };
  if (config.qrEmailParam && personEmail) dynamicParams[config.qrEmailParam] = personEmail;

  let res: Response;
  try {
    if (method === "GET") {
      const qs = new URLSearchParams();
      Object.entries(dynamicParams).forEach(([k, v]) => qs.set(k, String(v)));
      res = await fetchWithTimeout(`${url}${url.includes("?") ? "&" : "?"}${qs.toString()}`, {
        headers: { Accept: "application/json", "User-Agent": "SesameSuite-BookingConnector/1.0", ...authHeaders },
      });
    } else if ((config.qrEndpointBodyFormat || "json") === "json") {
      res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "SesameSuite-BookingConnector/1.0",
          ...authHeaders,
        },
        body: JSON.stringify(dynamicParams),
      });
    } else {
      const form = new URLSearchParams();
      Object.entries(dynamicParams).forEach(([k, v]) => form.set(k, String(v)));
      res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "SesameSuite-BookingConnector/1.0",
          ...authHeaders,
        },
        body: form.toString(),
      });
    }
  } catch (e) {
    throw new BookingSourceError(`Connexion à la source de QR code impossible : ${describeFetchError(e)}`);
  }
  if (!res.ok) throw new BookingSourceError(`La source de QR code a répondu ${res.status} ${res.statusText}`);

  const body = await parseJsonResponse(res, "La réponse de la source de QR code");
  console.log("[diag accessQr] status=%d body=%s", res.status, JSON.stringify(body).slice(0, 800));
  const qrImageRaw = config.qrImagePath ? getPath(body, config.qrImagePath) : undefined;
  const qrValueRaw = config.qrValuePath ? getPath(body, config.qrValuePath) : undefined;
  const accessCodeRaw = config.qrAccessCodePath ? getPath(body, config.qrAccessCodePath) : undefined;
  const validUntilRaw = config.qrValidUntilPath ? getPath(body, config.qrValidUntilPath) : undefined;

  let accessCode = accessCodeRaw !== undefined && accessCodeRaw !== null && accessCodeRaw !== "" ? String(accessCodeRaw) : undefined;

  // Code d'accès sur un endpoint séparé (ex : API Sesame Technology,
  // /ws/pass/findPasscode) — appelé uniquement si la réponse principale
  // n'en contenait pas déjà. Un échec ici dégrade juste l'affichage du code
  // (le QR, déjà obtenu, reste fonctionnel) : on le journalise sans faire
  // échouer tout l'appel pour autant.
  if (!accessCode && config.qrPasscodeEndpointPath) {
    try {
      const pcUrl = normalizeBaseUrl(config.baseUrl).replace(/\/$/, "") + config.qrPasscodeEndpointPath;
      let pcRes: Response;
      if (method === "GET") {
        const qs = new URLSearchParams();
        Object.entries(dynamicParams).forEach(([k, v]) => qs.set(k, String(v)));
        pcRes = await fetchWithTimeout(`${pcUrl}${pcUrl.includes("?") ? "&" : "?"}${qs.toString()}`, {
          headers: { Accept: "application/json", "User-Agent": "SesameSuite-BookingConnector/1.0", ...authHeaders },
        });
      } else if ((config.qrEndpointBodyFormat || "json") === "json") {
        pcRes = await fetchWithTimeout(pcUrl, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": "SesameSuite-BookingConnector/1.0",
            ...authHeaders,
          },
          body: JSON.stringify(dynamicParams),
        });
      } else {
        const form = new URLSearchParams();
        Object.entries(dynamicParams).forEach(([k, v]) => form.set(k, String(v)));
        pcRes = await fetchWithTimeout(pcUrl, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "SesameSuite-BookingConnector/1.0",
            ...authHeaders,
          },
          body: form.toString(),
        });
      }
      if (pcRes.ok) {
        const pcBody = await parseJsonResponse(pcRes, "La réponse du code d'accès");
        const pcRaw = getPath(pcBody, config.qrPasscodeValuePath || "passcode");
        if (pcRaw !== undefined && pcRaw !== null && pcRaw !== "") accessCode = String(pcRaw);
      }
    } catch (e) {
      console.error("[bookingSource] Échec de récupération du code d'accès (qrPasscodeEndpointPath) :", e);
    }
  }

  return {
    qrImage: typeof qrImageRaw === "string" && qrImageRaw ? qrImageRaw : undefined,
    qrValue: typeof qrValueRaw === "string" && qrValueRaw ? qrValueRaw : undefined,
    accessCode,
    validUntil: typeof validUntilRaw === "string" && validUntilRaw ? validUntilRaw : undefined,
  };
}

/**
 * Déclenche l'ouverture à distance d'une serrure pour UNE réservation (et,
 * si config.doorRoomParam est renseigné, sa chambre) auprès de la source
 * externe, via l'endpoint dédié config.doorEndpointPath. Inerte tant que ce
 * champ n'est pas configuré (même logique de repli que fetchAccessQr).
 */
export async function openDoor(
  config: BookingSourceConfig,
  bookingCode: string,
  roomCode?: string | null,
  personEmail?: string | null,
  personLastname?: string | null,
  personFirstname?: string | null
): Promise<{ opened: boolean }> {
  if (!config.doorEndpointPath) {
    throw new BookingSourceError(
      'Ouverture de porte à distance non configurée pour cet établissement — renseignez "Ouverture de porte à distance" dans les réglages techniques avancés de l\'Intégration réservations.'
    );
  }
  if (!config.baseUrl) throw new BookingSourceError("URL de base non configurée");
  const url = normalizeBaseUrl(config.baseUrl).replace(/\/$/, "") + config.doorEndpointPath;
  const { headers: authHeaders } = await buildAuthHeaders(config);
  const codeParam = config.doorCodeParam || "code";
  const roomParam = config.doorRoomParam || "";
  const method = (config.doorEndpointMethod || "POST").toUpperCase();
  const staticParams: Record<string, unknown> =
    config.doorEndpointBodyParams && typeof config.doorEndpointBodyParams === "object" ? (config.doorEndpointBodyParams as Record<string, unknown>) : {};
  const params: Record<string, unknown> = { ...staticParams, [codeParam]: bookingCode };
  if (roomParam && roomCode) params[roomParam] = roomCode;
  if (config.doorEmailParam && personEmail) params[config.doorEmailParam] = personEmail;
  if (config.doorLastnameParam && personLastname) params[config.doorLastnameParam] = personLastname;
  if (config.doorFirstnameParam && personFirstname) params[config.doorFirstnameParam] = personFirstname;

  let res: Response;
  try {
    if (method === "GET") {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => qs.set(k, String(v)));
      res = await fetchWithTimeout(`${url}${url.includes("?") ? "&" : "?"}${qs.toString()}`, {
        headers: { Accept: "application/json", "User-Agent": "SesameSuite-BookingConnector/1.0", ...authHeaders },
      });
    } else if ((config.doorEndpointBodyFormat || "json") === "json") {
      res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "SesameSuite-BookingConnector/1.0",
          ...authHeaders,
        },
        body: JSON.stringify(params),
      });
    } else {
      const form = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => form.set(k, String(v)));
      res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "SesameSuite-BookingConnector/1.0",
          ...authHeaders,
        },
        body: form.toString(),
      });
    }
  } catch (e) {
    throw new BookingSourceError(`Connexion à la serrure impossible : ${describeFetchError(e)}`);
  }
  if (!res.ok) throw new BookingSourceError(`La serrure a répondu ${res.status} ${res.statusText}`);

  const rawText = await res.text();
  console.log("[diag openDoor] status=%d params=%s body=%s", res.status, JSON.stringify(params), rawText.slice(0, 800));

  if (config.doorResponseSuccessPath) {
    let body: unknown;
    try {
      body = JSON.parse(rawText);
    } catch {
      throw new BookingSourceError(`La réponse d'ouverture de porte n'est pas un JSON valide — début : "${rawText.trim().slice(0, 200)}"`);
    }
    const raw = getPath(body, config.doorResponseSuccessPath);
    if (raw === false || raw === "false" || raw === 0) {
      throw new BookingSourceError("La serrure a refusé l'ouverture de la porte (réponse négative)");
    }
  }
  return { opened: true };
}
