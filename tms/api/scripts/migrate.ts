import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { config } from '../src/config';

/** Applique les migrations SQL numérotées une seule fois ; 999_grants est rejoué systématiquement. */
export async function migrate(url = config.migrationDatabaseUrl, log = true): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await client.query('SELECT pg_advisory_lock(424242)');
    const dir = join(__dirname, '..', 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of files) {
      const always = file.startsWith('999_');
      if (done.has(file) && !always) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        if (!always) await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        if (log && !always) console.log(`migration appliquée : ${file}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Échec migration ${file}: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => undefined);
    await client.end();
  }
}

if (require.main === module) {
  migrate().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
