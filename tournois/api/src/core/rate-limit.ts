import { Db } from './db';
import { AppError } from './errors';

/** Fenêtre fixe en base (multi-instance) : protège connexion, inscription et saisie de scores. */
export async function rateLimit(db: Db, key: string, max: number, windowSeconds: number): Promise<void> {
  const [row] = await db.query(
    `INSERT INTO rate_limits(key, window_start) VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2) * $2))
     ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limits.hits + 1 RETURNING hits`, [key, windowSeconds]);
  if (row.hits > max) throw new AppError(429, 'rate_limited', 'Trop de tentatives : réessayez dans quelques minutes.');
}
