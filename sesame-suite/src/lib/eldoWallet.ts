import type { WalletConfig, Booking } from "@prisma/client";
import { prisma } from "../db";
import { assertSafeUrl } from "./ssrfGuard";

// Connecteur EldoWallet (module "Wallet" du catalogue d'abonnement) — un
// compte EldoWallet par établissement, appelé en REST brut (comme les
// autres connecteurs de ce projet, cf. lib/payment.ts) plutôt qu'avec un
// SDK. Génère un pass Apple Wallet / Google Wallet pour une réservation
// (POST /hotels/{hotelId}/passes) que le client peut ajouter à son
// téléphone — cf. routes/wallet.ts et le bouton "Générer le pass Wallet"
// du panneau admin Réservations.

// EldoWallet fournit un environnement "beta" séparé (identifiants hôtel/
// token distincts de la production) — cf. WalletConfig.apiBase, réglable
// dans le panneau admin ("Compte EldoWallet"). ELDOWALLET_API_BASE_OVERRIDE
// reste disponible pour les tests locaux (mock serveur), mais l'URL choisie
// par établissement (config.apiBase) prime dès qu'elle est renseignée.
const ELDOWALLET_API_BASE_DEFAULT = process.env.ELDOWALLET_API_BASE_OVERRIDE || "https://api-v2.eldowallet.fr";
const ELDOWALLET_TIMEOUT_MS = 15000;

export class WalletError extends Error {}

async function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  await assertSafeUrl(url); // protection SSRF — cf. lib/ssrfGuard.ts
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ELDOWALLET_TIMEOUT_MS) });
}

function describeFetchError(e: unknown): string {
  if (!(e instanceof Error)) return "erreur réseau";
  if (e.name === "TimeoutError") return `délai de ${ELDOWALLET_TIMEOUT_MS / 1000}s dépassé sans réponse d'EldoWallet`;
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
    throw new WalletError(`${context} n'est pas un JSON valide — début de la réponse reçue : "${snippet}"`);
  }
}

export type EldoWalletAuthConfig = {
  entityId: string;
  hotelId: string | null;
  apiToken: string | null;
  apiUsername?: string | null;
  apiPassword?: string | null;
  lang: string;
  apiBase?: string | null;
};

/**
 * POST /auth/login ("Login a user and return authentication token") —
 * body {username, password} → 201 {token} (confirmé par le client
 * 13/10/2026 via capture Swagger, pas de champ d'expiration dans la
 * réponse : EldoWallet ne dit jamais combien de temps un jeton reste
 * valable, juste qu'il finit par expirer).
 */
async function loginEldoWallet(apiBase: string, username: string, password: string, lang: string): Promise<string> {
  const url = `${apiBase}/auth/login`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(lang ? { "x-lang": lang } : {}) },
      body: JSON.stringify({ username, password }),
    });
  } catch (e) {
    throw new WalletError(`Connexion à EldoWallet impossible (login) : ${describeFetchError(e)}`);
  }
  const json = await parseJsonResponse(res, "La réponse de connexion EldoWallet");
  if (!res.ok) {
    const message = json?.message || `Erreur HTTP ${res.status}`;
    throw new WalletError(`Échec de connexion EldoWallet : ${json?.errorCode ? `${message} (code : ${json.errorCode})` : message}`);
  }
  if (!json?.token) throw new WalletError('Réponse de connexion EldoWallet sans champ "token"');
  return json.token as string;
}

/**
 * Jeton à utiliser pour le PROCHAIN appel — celui déjà en cache (apiToken)
 * s'il existe, sinon un login immédiat si identifiant/mot de passe sont
 * renseignés. Ne vérifie jamais si le jeton en cache est encore valide
 * (EldoWallet ne donne pas sa durée de vie) : c'est le 401 de l'appel réel,
 * géré dans eldoWalletRequest ci-dessous, qui déclenche un re-login.
 */
async function ensureToken(config: EldoWalletAuthConfig, apiBase: string): Promise<string> {
  if (config.apiToken) return config.apiToken;
  if (!config.apiUsername || !config.apiPassword) throw new WalletError("Token EldoWallet non configuré");
  const token = await loginEldoWallet(apiBase, config.apiUsername, config.apiPassword, config.lang);
  await prisma.walletConfig.update({ where: { entityId: config.entityId }, data: { apiToken: token } });
  return token;
}

async function eldoWalletRequest(
  config: EldoWalletAuthConfig,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  _retrying = false
): Promise<any> {
  if (!config.hotelId) throw new WalletError("Identifiant hôtel EldoWallet non configuré");
  const base = config.apiBase || ELDOWALLET_API_BASE_DEFAULT;
  const token = await ensureToken(config, base);
  const url = `${base}${path}`;
  const requestHeaders = {
    Authorization: `Bearer ${token}`,
    // EldoWallet exige aussi ce second en-tête, distinct du Bearer
    // standard (confirmé le 07/09/2026 via leur documentation Swagger,
    // dont l'exemple "Try it out" envoie systématiquement les deux avec
    // la même valeur de token).
    "x-access-token": token,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(config.lang ? { "x-lang": config.lang } : {}),
  };
  // Log de diagnostic temporaire (09/09/2026) — demandé par le support
  // EldoWallet (capture Postman entête + corps) : reproduit ici la requête
  // RÉELLEMENT envoyée par l'app, à copier telle quelle plutôt que de la
  // reconstituer à la main. Le jeton est redacté (cf. audit sécurité du
  // 15/09/2026) — il ne doit jamais atterrir en clair dans des logs
  // serveur, moins protégés que la base et souvent expédiés vers un
  // agrégateur externe.
  const redactedHeaders = { ...requestHeaders, Authorization: "Bearer ***redacted***", "x-access-token": "***redacted***" };
  console.log("[diag eldoWallet] %s %s\nheaders=%s\nbody=%s", method, url, JSON.stringify(redactedHeaders), body ? JSON.stringify(body) : "(aucun)");
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method,
      headers: requestHeaders,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new WalletError(`Appel à EldoWallet impossible : ${describeFetchError(e)}`);
  }
  const json = await parseJsonResponse(res, "La réponse d'EldoWallet");
  console.log("[diag eldoWallet] status=%d response=%s", res.status, JSON.stringify(json).slice(0, 800));
  if (!res.ok) {
    // 401 + identifiant/mot de passe renseignés : le jeton en cache a
    // probablement expiré (EldoWallet ne prévient pas à l'avance, cf.
    // demande client 13/10/2026) — un seul re-login puis nouvel essai,
    // plutôt que de faire échouer l'appel et obliger l'admin à venir coller
    // un nouveau jeton à la main. _retrying évite une boucle si le login
    // réussit mais que l'appel échoue encore pour une autre raison.
    if (res.status === 401 && !_retrying && config.apiUsername && config.apiPassword) {
      const freshToken = await loginEldoWallet(base, config.apiUsername, config.apiPassword, config.lang);
      await prisma.walletConfig.update({ where: { entityId: config.entityId }, data: { apiToken: freshToken } });
      return eldoWalletRequest({ ...config, apiToken: freshToken }, method, path, body, true);
    }
    // Format d'erreur EldoWallet observé : { message, errorCode, path, date }.
    // errorCode ajouté au message affiché (04/09/2026) : un "Non autorisé !"
    // seul ne dit pas si c'est le token, l'identifiant hôtel, ou autre chose
    // — le code renvoyé par EldoWallet aide à distinguer sans deviner.
    const message = json?.message || `Erreur HTTP ${res.status}`;
    throw new WalletError(json?.errorCode ? `${message} (code : ${json.errorCode})` : message);
  }
  return json;
}

export interface HotelPassResult {
  id: string;
  shortLink: string | null;
  status: string | null;
}

/**
 * Crée un pass Wallet pour une réservation — POST /hotels/{hotelId}/passes.
 * barcode = code de réservation (identifiant stable, unique par
 * établissement) : un second appel avec le même barcode renvoie une erreur
 * 409 côté EldoWallet ("Resource already exists") plutôt que de dupliquer
 * le pass — cf. routes/wallet.ts, qui n'appelle cette fonction que si
 * aucun pass n'a encore été enregistré sur la réservation.
 */
export async function createHotelPass(
  config: WalletConfig,
  booking: Booking,
  opts: { roomNumber?: string; roomCode?: string } = {}
): Promise<HotelPassResult> {
  const body: Record<string, unknown> = {
    checkin: booking.startDate.toISOString(),
    checkout: booking.endDate.toISOString(),
    firstName: booking.personFirstname,
    lastName: booking.personLastname,
    barcode: booking.code,
  };
  if (booking.personEmail) body.email = booking.personEmail;
  if (booking.personPhone) body.phoneNumber = booking.personPhone;
  if (opts.roomNumber) body.roomNumber = opts.roomNumber;
  if (opts.roomCode) body.roomCode = opts.roomCode;

  const json = await eldoWalletRequest(config, "POST", `/hotels/${encodeURIComponent(config.hotelId!)}/passes`, body);
  return { id: json._id, shortLink: json.shortLink || null, status: json.status || null };
}

export interface HotelWalletInfo {
  passBuilderPassTemplateId: string | null;
  name: string | null;
  logo: string | null;
}

/**
 * Récupère le modèle de pass (visuel) actuellement lié au compte EldoWallet
 * de l'hôtel — GET /hotels/{hotelId}. Le modèle n'est PAS un paramètre de
 * chaque appel de création de pass : il est configuré une fois côté
 * EldoWallet (créé via leur API POST /hotels ou via leur "manager"), et
 * c'est ce champ wallet.passBuilderPassTemplateId qui sert de confirmation
 * qu'un modèle personnalisé est bien rattaché (plutôt que le modèle par
 * défaut) — cf. panneau admin "Wallet", bouton "Récupérer le modèle actif".
 * La forme exacte de la réponse (objet hôtel direct, ou wrappé sous une clé
 * "hotel") n'est pas garantie par la documentation Swagger fournie — les
 * deux formes sont donc lues ici, et l'appel reste loggé par le diagnostic
 * temporaire d'eldoWalletRequest en cas de forme imprévue.
 */
export async function getHotelInfo(config: EldoWalletAuthConfig): Promise<HotelWalletInfo> {
  const json = await eldoWalletRequest(config, "GET", `/hotels/${encodeURIComponent(config.hotelId!)}`);
  const hotel = json?.hotel || json;
  const wallet = hotel?.wallet || {};
  return {
    passBuilderPassTemplateId: wallet.passBuilderPassTemplateId || null,
    name: wallet.name || null,
    logo: wallet.logo || null,
  };
}
