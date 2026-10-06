import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { config } from '../config';

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(key, expected);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Coffre symétrique AES-256-GCM pour les secrets clients (clés IA, SMTP, jetons bancaires). */
export function sealSecret(plain: string): string {
  const key = Buffer.from(config.secretKey, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
export function openSecret(sealed: string): string {
  const [v, iv, tag, enc] = sealed.split('.');
  if (v !== 'v1') throw new Error('format de secret inconnu');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(config.secretKey, 'base64'), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8');
}
export const maskSecret = (s: string) => (s.length <= 4 ? '****' : `…${s.slice(-4)}`);

/** Empreinte canonique (clés triées) d'un objet JSON : idempotence et détection de changement. */
export function stableHash(value: unknown): string {
  const canon = (v: any): any =>
    Array.isArray(v) ? v.map(canon)
      : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
        : v;
  return sha256(JSON.stringify(canon(value)));
}
