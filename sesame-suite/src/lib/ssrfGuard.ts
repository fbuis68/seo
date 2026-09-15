import dns from "node:dns/promises";
import net from "node:net";

/**
 * Protection SSRF — à appeler avant tout appel sortant vers une URL saisie
 * par un admin hôtel (baseUrl d'un connecteur réservations/casiers/wallet,
 * cf. lib/bookingSource.ts, lib/lockerSource.ts, lib/eldoWallet.ts). Un
 * compte hôtel est moins privilégié qu'un compte Sesame mais reste
 * authentifié : sans ce garde-fou, une baseUrl comme
 * "http://169.254.169.254/latest/meta-data/" (métadonnées cloud) ou une
 * adresse du réseau interne serait fetchée telle quelle par le serveur,
 * transformant une intégration mal (ou malicieusement) configurée par UN
 * établissement en accès au réseau interne de TOUTE la plateforme — cf.
 * audit sécurité du 15/09/2026.
 *
 * Résout le nom d'hôte (DNS) pour vérifier l'IP réellement contactée, pas
 * seulement la chaîne saisie — un nom de domaine public peut pointer vers
 * une IP privée (DNS rebinding basique). Reste un contrôle "au meilleur
 * effort" : un attaquant changeant la résolution DNS entre cette vérification
 * et l'appel fetch() réel (quelques millisecondes plus tard) le contournerait
 * — une protection complète nécessiterait un proxy sortant dédié, hors de
 * portée de ce correctif.
 */
export class SsrfBlockedError extends Error {}

const BLOCKED_MESSAGE = "adresse réseau interne/réservée — non autorisée pour un connecteur";

function isBlockedIp(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (net.isIPv4(v4)) {
    const parts = v4.split(".").map(Number);
    const [a, b] = parts;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local, inclut les métadonnées cloud (169.254.169.254)
    if (a === 0) return true; // "this network"
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
    return false;
  }
  if (net.isIPv6(v4)) {
    const low = v4.toLowerCase();
    if (low === "::1" || low === "::") return true; // loopback / unspecified
    if (low.startsWith("fe80:")) return true; // link-local
    if (low.startsWith("fc") || low.startsWith("fd")) return true; // unique local (ULA)
    return false;
  }
  return false;
}

export async function assertSafeUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError("URL invalide");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SsrfBlockedError(`Protocole "${u.protocol}" non autorisé — seuls http/https le sont`);
  }
  const hostname = u.hostname.replace(/^\[|\]$/g, ""); // retire les crochets d'une IPv6 littérale dans l'URL
  if (hostname === "localhost") throw new SsrfBlockedError(BLOCKED_MESSAGE);

  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new SsrfBlockedError(BLOCKED_MESSAGE);
    return;
  }

  try {
    const records = await dns.lookup(hostname, { all: true });
    if (records.some((r) => isBlockedIp(r.address))) throw new SsrfBlockedError(BLOCKED_MESSAGE);
  } catch (e) {
    if (e instanceof SsrfBlockedError) throw e;
    // Résolution DNS échouée : laissé passer, fetch() échouera de toute
    // façon juste après avec une erreur explicite (ENOTFOUND) — inutile de
    // dupliquer ce diagnostic ici.
  }
}
