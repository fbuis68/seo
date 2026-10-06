import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { config } from '../config';
import { AppError } from './errors';

/** Plages interdites : privées, loopback, lien-local (métadonnées cloud 169.254.169.254), CGNAT, multicast… */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

/**
 * Résout l'hôte et refuse toute adresse interne (protection SSRF / DNS rebinding).
 * Retourne l'IP validée, à utiliser pour la connexion (épinglage).
 */
export async function assertPublicHost(hostname: string, allowlist?: string[]): Promise<string> {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (allowlist && !allowlist.includes(host)) throw new AppError(400, 'host_not_allowed', `Hôte non autorisé : ${host}`);
  if (/^(localhost|metadata(\.google\.internal)?|.*\.internal|.*\.local)$/.test(host) && !config.allowPrivateHostsForTests) {
    throw new AppError(400, 'host_forbidden', 'Hôte interne interdit.');
  }
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => { throw new AppError(400, 'dns_error', `Hôte introuvable : ${host}`); });
  if (!addrs.length) throw new AppError(400, 'dns_error', `Hôte introuvable : ${host}`);
  if (!config.allowPrivateHostsForTests && addrs.some((a) => isPrivateIp(a.address))) {
    throw new AppError(400, 'host_forbidden', 'Adresse interne ou réservée interdite (protection SSRF).');
  }
  return addrs[0].address;
}
