import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Client } from 'pg';
import { Observable, Subject, filter, map } from 'rxjs';
import { config } from '../config';
import { Db, many, Tx } from './db';

/** Journal d'audit (non modifiable) : avant/après, auteur, motif. */
export async function audit(tx: Tx, e: { orgId: string; tournamentId?: string; actorId?: string | null; entity: string; entityId?: string | null; action: string; before?: unknown; after?: unknown; reason?: string | null }) {
  await tx.query(
    `INSERT INTO audit_log(org_id, tournament_id, actor_id, entity, entity_id, action, before, after, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [e.orgId, e.tournamentId ?? null, e.actorId ?? null, e.entity, e.entityId ?? null, e.action,
      e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after), e.reason ?? null]);
}

export interface LiveEvent { tournamentId: string; type: string; matchId?: string; at: string; }

/**
 * Temps réel (§13.4) : l'événement est publié par NOTIFY dans la transaction métier, donc diffusé
 * uniquement après validation (jamais d'état non validé), et reçu par toutes les instances de l'API (LISTEN),
 * qui le relaient aux clients connectés en Server-Sent Events. Le client se replie sur un rafraîchissement
 * périodique si le flux est interrompu.
 */
@Injectable()
export class LiveEvents implements OnModuleInit, OnModuleDestroy {
  private bus = new Subject<LiveEvent>();
  private client?: Client;

  async onModuleInit() {
    this.client = new Client({ connectionString: config.databaseUrl });
    this.client.on('error', () => undefined);
    await this.client.connect();
    this.client.on('notification', (n) => {
      try { this.bus.next(JSON.parse(n.payload ?? '{}')); } catch { /* charge utile invalide ignorée */ }
    });
    await this.client.query('LISTEN tn_events');
  }
  async onModuleDestroy() { await this.client?.end().catch(() => undefined); }

  static async emit(tx: Tx, tournamentId: string, type: string, matchId?: string) {
    const e: LiveEvent = { tournamentId, type, matchId, at: new Date().toISOString() };
    await tx.query('SELECT pg_notify($1, $2)', ['tn_events', JSON.stringify(e)]);
  }

  stream(tournamentIds: string[]): Observable<{ data: LiveEvent; type: string }> {
    const set = new Set(tournamentIds);
    return this.bus.pipe(filter((e) => set.has(e.tournamentId)), map((e) => ({ data: e, type: 'update' })));
  }
  /** Pour les tests : prochain événement d'un tournoi. */
  next(tournamentId: string, timeoutMs = 3000): Promise<LiveEvent> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { sub.unsubscribe(); reject(new Error('timeout')); }, timeoutMs);
      const sub = this.bus.pipe(filter((e) => e.tournamentId === tournamentId)).subscribe((e) => { clearTimeout(t); sub.unsubscribe(); resolve(e); });
    });
  }
}

export interface OutMail { to: string; subject: string; text: string; }

/** Emails : SMTP si configuré, sinon boîte d'envoi locale (développement, tests). */
@Injectable()
export class Mailer {
  readonly devOutbox: OutMail[] = [];
  private transport: any;
  async send(m: OutMail) {
    if (!config.smtpUrl) {
      this.devOutbox.push(m);
      if (this.devOutbox.length > 500) this.devOutbox.shift();
      if (!config.isTest) console.log(`[mail] ${m.to} — ${m.subject}`);
      return;
    }
    if (!this.transport) this.transport = (await import('nodemailer')).createTransport(config.smtpUrl);
    await this.transport.sendMail({ from: config.mailFrom, ...m }).catch((e: Error) => console.error('[mail]', e.message));
  }
}

export type NotificationType =
  | 'registration_confirmed' | 'registration_pending' | 'registration_waitlist' | 'match_announced' | 'match_changed'
  | 'score_to_confirm' | 'score_disputed' | 'score_official' | 'qualified' | 'final_ranking' | 'claim_request' | 'referee_assigned';

/** Préférences par type : notification web toujours, email pour les événements importants. */
const EMAIL_TYPES = new Set<NotificationType>(['registration_confirmed', 'registration_waitlist', 'match_changed', 'score_to_confirm', 'score_disputed', 'qualified', 'final_ranking', 'referee_assigned']);

@Injectable()
export class Notifier {
  constructor(private mailer: Mailer) {}
  /** Enregistre les notifications dans la transaction ; les emails partent après validation. */
  async notify(tx: Tx, n: { orgId: string; tournamentId?: string; userIds: (string | null | undefined)[]; type: NotificationType; title: string; body?: string; link?: string }) {
    const ids = [...new Set(n.userIds.filter((x): x is string => !!x))];
    if (!ids.length) return;
    const email = EMAIL_TYPES.has(n.type);
    await tx.query(
      `INSERT INTO notifications(org_id, tournament_id, user_id, type, title, body, link, channels)
       SELECT $1, $2, u, $3, $4, $5, $6, $7 FROM unnest($8::uuid[]) u`,
      [n.orgId, n.tournamentId ?? null, n.type, n.title, n.body ?? null, n.link ?? null, email ? ['web', 'email'] : ['web'], ids]);
    if (email) {
      const users = await many(tx, 'SELECT email FROM users WHERE id = ANY($1) AND anonymized_at IS NULL', [ids]);
      const link = n.link ? `\n\n${config.appUrl}${n.link}` : '';
      // Envoi différé hors transaction (un échec SMTP n'annule pas l'action).
      setImmediate(() => { for (const u of users) void this.mailer.send({ to: u.email, subject: n.title, text: `${n.body ?? n.title}${link}` }); });
    }
  }
}
