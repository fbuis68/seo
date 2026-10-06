import { INestApplicationContext } from '@nestjs/common';
import { Db } from './core/db';
import { JobsService } from './core/jobs.service';

/** Tâches périodiques (dédupliquées par jour) : rapprochement paiement, purge IA, banque, OpenData. */
async function schedulePeriodic(app: INestApplicationContext) {
  const jobs = app.get(JobsService); const db = app.get(Db);
  const day = new Date().toISOString().slice(0, 10);
  await jobs.enqueue(null, 'billing.reconcile', {}, { dedupeKey: `billing.reconcile:${day}` });
  await jobs.enqueue(null, 'ai.purge', {}, { dedupeKey: `ai.purge:${day}` });
  for (const src of ['dgefp_of', 'rncp_rs', 'mcf_offre']) {
    if (process.env[`OPENDATA_URL_${src.toUpperCase()}`]) await jobs.enqueue(null, 'opendata.refresh', { source: src }, { dedupeKey: `od:${src}:${day}` });
  }
  for (const t of await db.query(`SELECT id FROM tenants WHERE closed_at IS NULL`)) {
    const conns = await db.tenantTx(t.id, (tx) => tx.query(`SELECT id FROM bank_connections WHERE status='active'`));
    for (const c of conns.rows) await jobs.enqueue(null, 'bank.sync', { tenantId: t.id, connectionId: c.id }, { tenantId: t.id, dedupeKey: `bank:${c.id}:${day}` });
  }
}

export function startWorkerLoop(app: INestApplicationContext, intervalMs = 2000) {
  const jobs = app.get(JobsService);
  let stopped = false; let lastPeriodic = 0;
  const tick = async () => {
    if (stopped) return;
    try {
      if (Date.now() - lastPeriodic > 3600e3) { lastPeriodic = Date.now(); await jobs.releaseStale(); await schedulePeriodic(app); }
      while ((await jobs.runOnce(20)) > 0) { /* vide la file */ }
    } catch (e) { console.error('[worker]', e); }
    setTimeout(tick, intervalMs);
  };
  void tick();
  return () => { stopped = true; };
}
