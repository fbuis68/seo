import type { WalletConfig, Booking } from "@prisma/client";

// Connecteur EldoWallet (module "Wallet" du catalogue d'abonnement) — un
// compte EldoWallet par établissement, appelé en REST brut (comme les
// autres connecteurs de ce projet, cf. lib/payment.ts) plutôt qu'avec un
// SDK. Génère un pass Apple Wallet / Google Wallet pour une réservation
// (POST /hotels/{hotelId}/passes) que le client peut ajouter à son
// téléphone — cf. routes/wallet.ts et le bouton "Générer le pass Wallet"
// du panneau admin Réservations.

const ELDOWALLET_API_BASE = process.env.ELDOWALLET_API_BASE_OVERRIDE || "https://api-v2.eldowallet.fr";
const ELDOWALLET_TIMEOUT_MS = 15000;

export class WalletError extends Error {}

function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
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

async function eldoWalletRequest(
  config: { hotelId: string | null; apiToken: string | null; lang: string },
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>
): Promise<any> {
  if (!config.apiToken) throw new WalletError("Token EldoWallet non configuré");
  if (!config.hotelId) throw new WalletError("Identifiant hôtel EldoWallet non configuré");
  const url = `${ELDOWALLET_API_BASE}${path}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(config.lang ? { "x-lang": config.lang } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new WalletError(`Appel à EldoWallet impossible : ${describeFetchError(e)}`);
  }
  const json = await parseJsonResponse(res, "La réponse d'EldoWallet");
  if (!res.ok) {
    // Format d'erreur EldoWallet observé : { message, errorCode, path, date }
    const message = json?.message || `Erreur HTTP ${res.status}`;
    throw new WalletError(message);
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
