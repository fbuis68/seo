import 'reflect-metadata';
import { createReadStream, statSync } from 'fs';
import { basename } from 'path';
import { createApp } from '../src/bootstrap';
import { Db } from '../src/core/db';
import { MigrationService } from '../src/modules/migration/migration.service';

/**
 * Reprise MCDF en ligne de commande (sur le serveur) : pas de limite de dépôt ni de délai HTTP.
 * Le lot créé apparaît ensuite dans Réglages → Reprise (rapport, annulation).
 *
 *   node dist/scripts/mcdf-import.js --file /import/mcdf.sql.gz --email moi@centre.fr            → liste des organismes MCDF
 *   node dist/scripts/mcdf-import.js --file … --email … --entities E1[,E2]                        → simulation (rien n'est écrit)
 *   node dist/scripts/mcdf-import.js --file … --email … --entities E1 --publish                  → simulation puis publication
 *   options : --tenant <uuid> si le compte gère plusieurs espaces ; --instance <nom> (défaut mcdf)
 */
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const flag = (k: string) => process.argv.includes(`--${k}`);

async function main() {
  const file = arg('file'), email = arg('email');
  if (!file || !email) throw new Error('Usage : --file <sauvegarde.sql.gz> --email <compte gestionnaire> [--entities E1,E2] [--publish] [--tenant <uuid>]');
  process.env.WORKER_INLINE = '0';
  process.env.TMS_CLI = '1';
  const app = await createApp();
  await app.init();
  const db = app.get(Db), m = app.get(MigrationService);
  const user = (await db.query(`SELECT id, email, full_name FROM users WHERE lower(email)=lower($1)`, [email]))[0];
  if (!user) throw new Error(`Compte introuvable : ${email}`);
  const tenants = await db.query(`SELECT m.tenant_id, t.legal_name FROM memberships m JOIN tenants t ON t.id=m.tenant_id
    WHERE m.user_id=$1 AND m.role IN ('owner','manager') AND (m.expires_at IS NULL OR m.expires_at > now())`, [user.id]).catch(() => []);
  const tenantId = arg('tenant') ?? (tenants.length === 1 ? tenants[0].tenant_id : undefined);
  if (!tenantId) throw new Error(`Précisez --tenant parmi : ${tenants.map((t: any) => `${t.tenant_id} (${t.legal_name})`).join(', ') || 'aucun espace géré'}`);
  const ctx: any = { userId: user.id, email: user.email, fullName: user.full_name, emailVerified: true, sessionId: 'cli', tenantId, role: 'owner' };
  const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

  const size = statSync(file).size;
  log(`Sauvegarde ${file} (${Math.round(size / 1024 / 1024)} Mo)`);
  const b = await m.create(ctx, { sourceSoftware: 'mcdf', sourceInstanceId: arg('instance') ?? 'mcdf' });
  const up = await m.upload(ctx, b.id, createReadStream(file), basename(file), { maxBytes: 8 * 1024 ** 3 });
  if (up.status === 'rejected') throw new Error(`Refusée : ${JSON.stringify(up.diagnostic.rejections)}`);
  log('Lecture de la sauvegarde…');
  const det: any = await m.detect(ctx, b.id);
  console.table(det.mcdf.entities.map((e: any) => ({ id: e.id, organisme: e.name, parent: e.parentId ?? '', personnes: e.persons, sessions: e.sessions, conventions: e.conventions, factures: e.invoices })));
  for (const w of det.mcdf.warnings) log('!', w);
  const entities = arg('entities')?.split(',').map((x) => x.trim()).filter(Boolean);
  if (!entities?.length) {
    await m.cancel(ctx, b.id);
    log('Relancez avec --entities <id,…> pour simuler.');
    return app.close();
  }
  await m.confirmProfile(ctx, b.id, { profile: 'mcdf', entityIds: entities });
  log(`Simulation sur ${entities.join(', ')}…`);
  const sim: any = await m.simulate(ctx, b.id, {});
  console.table(Object.fromEntries(Object.entries(sim.summary).map(([k, v]: any) => [k, { lues: v.read, créées: v.create, inchangées: v.unchanged, rejetées: v.reject, exclues: v.exclude, alertes: v.warnings }])));
  for (const i of sim.issues.slice(0, 40)) log(i.severity === 'blocking' ? 'REJET' : 'alerte', i.entity, i.legacyId ?? '', i.message);
  if (sim.issues.length > 40) log(`… ${sim.issues.length - 40} autres (détail dans Réglages → Reprise).`);
  if (!sim.quota.fits) log('QUOTA :', sim.quota.message, JSON.stringify(sim.quota.over));
  if (!flag('publish')) { log(`Simulation terminée (lot ${b.id}, rien n'est écrit). Ajoutez --publish pour publier.`); return app.close(); }
  if (!sim.canCommit) throw new Error('Publication impossible (quota de l’offre dépassé).');
  log('Publication…');
  const rep: any = await m.commit(ctx, b.id);
  log(`Publié : lot ${b.id} — ${rep.financial[0].invoices} factures, ${rep.financial[0].totalTtc} € TTC, ${rep.paymentsImported} € de règlements.`);
  await app.close();
}

main().catch((e) => { console.error('ÉCHEC :', e.message ?? e); process.exit(1); });
