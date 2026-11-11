import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

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
/** Jeton non prédictible (256 bits par défaut), encodé pour URL. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const randomInt31 = () => randomBytes(4).readUInt32BE() & 0x7fffffff;
