import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import nodemailer from 'nodemailer';
import { AuditService } from '../../core/audit.service';
import { RequestContext } from '../../core/context';
import { maskSecret, openSecret, sealSecret } from '../../core/crypto';
import { Db, many, one } from '../../core/db';
import { AppError, badRequest, notFound } from '../../core/errors';
import { JobsService } from '../../core/jobs.service';
import { assertPublicHost } from '../../core/ssrf';
import { StorageService } from '../../core/storage';
import { SystemMailer } from '../../core/system-mail';
import { EntitlementsService } from '../billing/entitlements.service';

/** Commandes SMTP antérieures à la transmission du message : échec certain, pas d'ambiguïté. */
const PRE_DATA_COMMANDS = ['CONN', 'EHLO', 'HELO', 'STARTTLS', 'AUTH', 'AUTH PLAIN', 'AUTH LOGIN', 'AUTH XOAUTH2', 'MAIL FROM', 'RCPT TO', 'API'];
const TRANSIENT = ['ECONNECTION', 'ETIMEDOUT', 'EDNS', 'ESOCKET'];

export interface SmtpInput {
  host: string; port: 465 | 587; security: 'tls' | 'starttls'; authMode: 'password' | 'oauth2';
  username: string; secret: string; fromEmail: string; fromName?: string; replyTo?: string;
}

/**
 * Envoi email : SMTP du client (offres payantes) ou canal transactionnel de la plateforme.
 * TLS obligatoire, certificat validé, hôte filtré (SSRF), file asynchrone avec Message-ID stable,
 * état "delivery_unknown" plutôt que renvoi aveugle. "accepted_by_smtp" ≠ délivré/lu.
 */
@Injectable()
export class MailService {
  constructor(private db: Db, private ent: EntitlementsService, private jobs: JobsService, private storage: StorageService,
    private system: SystemMailer, private audit: AuditService) {
    this.jobs.register('mail.send', (p) => this.deliver(p.tenantId, p.messageId));
  }

  listConnections(ctx: RequestContext) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `SELECT id, kind, host, port, security, auth_mode, username, from_email, from_name, reply_to, status, last_test_at, last_error FROM mail_connections ORDER BY created_at`));
  }

  async createSmtp(ctx: RequestContext, b: SmtpInput) {
    if (!((b.port === 465 && b.security === 'tls') || (b.port === 587 && b.security === 'starttls'))) {
      throw badRequest('invalid_port', 'Ports proposés : 465 (TLS implicite) ou 587 (STARTTLS obligatoire).', 'port');
    }
    await assertPublicHost(b.host);
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      await this.ent.assertQuota(tx, ctx.tenantId, 'smtpMailboxes');
      const c = await one(tx, `INSERT INTO mail_connections(tenant_id, host, port, security, auth_mode, username, secret_enc, from_email, from_name, reply_to)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, host, port, security, username, from_email, status`,
        [ctx.tenantId, b.host.toLowerCase(), b.port, b.security, b.authMode, b.username, sealSecret(b.secret), b.fromEmail, b.fromName ?? null, b.replyTo ?? null]);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'mail.connection_created', entityType: 'mail_connection', entityId: c!.id, data: { host: b.host, secret: maskSecret(b.secret) } });
      return c;
    });
  }

  async disable(ctx: RequestContext, id: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const r = await one(tx, `UPDATE mail_connections SET status='disabled', secret_enc='' WHERE id=$1 RETURNING id`, [id]);
      if (!r) throw notFound('Connexion email');
      return { disabled: true };
    });
  }

  /** Transport épinglé sur l'IP validée ; nom de serveur conservé pour la vérification TLS. */
  private async transport(conn: any) {
    const ip = await assertPublicHost(conn.host);
    const secret = openSecret(conn.secret_enc);
    return nodemailer.createTransport({
      host: ip, port: conn.port, secure: conn.security === 'tls', requireTLS: conn.security === 'starttls',
      tls: { servername: conn.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      auth: conn.auth_mode === 'oauth2' ? { type: 'OAuth2', user: conn.username, accessToken: secret } : { user: conn.username, pass: secret },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    });
  }

  /** Test : connexion + authentification, puis email au seul destinataire confirmé (l'utilisateur). */
  async test(ctx: RequestContext, id: string) {
    const conn = await this.db.tenantTx(ctx.tenantId, (tx) => one(tx, `SELECT * FROM mail_connections WHERE id=$1 AND status <> 'disabled'`, [id]));
    if (!conn) throw notFound('Connexion email');
    let status = 'ok', error: string | null = null;
    try {
      const t = await this.transport(conn);
      await t.verify();
      await t.sendMail({ from: { name: conn.from_name ?? '', address: conn.from_email }, to: ctx.email, subject: 'Test de configuration SMTP', text: 'Ce message confirme que votre serveur SMTP est correctement configuré.' });
    } catch (e: any) {
      status = 'error';
      // Message actionnable, sans secret.
      error = e.code === 'EAUTH' ? 'Authentification refusée : vérifiez identifiant/mot de passe d’application ou OAuth.'
        : /certificate|self.signed|CERT/i.test(e.message) ? 'Certificat TLS invalide : connexion refusée (aucun contournement).'
          : e.code === 'ETIMEDOUT' || e.code === 'ECONNECTION' ? 'Serveur injoignable sur ce port.' : (e instanceof AppError ? e.message : `Échec SMTP (${e.code ?? 'erreur'})`);
    }
    await this.db.tenantTx(ctx.tenantId, (tx) => tx.query(`UPDATE mail_connections SET status=$2, last_test_at=now(), last_error=$3 WHERE id=$1`, [id, status, error]));
    return { status, error };
  }

  /** Mise en file : quota emails consommé, identité expéditeur explicite, aucun envoi synchrone. */
  async queue(ctx: RequestContext, b: { to: string[]; subject: string; text: string; html?: string; connectionId?: string | null; attachments?: string[]; relatedType?: string; relatedId?: string; scheduledAt?: string }) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      if (b.connectionId) {
        this.ent.requireFeature(ctx.entitlements ?? (await this.ent.get(ctx.tenantId, tx)), 'smtp.custom');
        const c = await one(tx, `SELECT status FROM mail_connections WHERE id=$1`, [b.connectionId]);
        if (!c || c.status === 'disabled') throw notFound('Connexion email');
      }
      for (const d of b.attachments ?? []) if (!(await one(tx, `SELECT 1 FROM documents WHERE id=$1`, [d]))) throw notFound('Pièce jointe');
      await this.ent.consume(tx, ctx.tenantId, 'emails', b.to.length, ctx.entitlements);
      const domain = b.connectionId ? (await one(tx, `SELECT split_part(from_email,'@',2) d FROM mail_connections WHERE id=$1`, [b.connectionId]))!.d : 'mail.invalid';
      const m = await one(tx, `INSERT INTO mail_messages(tenant_id, connection_id, message_id, to_addresses, subject, body_text, body_html, attachments, related_type, related_id, scheduled_at, created_by)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11::timestamptz, now()),$12) RETURNING id, status, message_id, scheduled_at`,
        [ctx.tenantId, b.connectionId ?? null, `<${randomUUID()}@${domain}>`, b.to, b.subject, b.text, b.html ?? null, JSON.stringify((b.attachments ?? []).map((id) => ({ document_id: id }))),
          b.relatedType ?? null, b.relatedId ?? null, b.scheduledAt ?? null, ctx.userId]);
      await this.jobs.enqueue(tx, 'mail.send', { tenantId: ctx.tenantId, messageId: m!.id }, { tenantId: ctx.tenantId, runAt: new Date(m!.scheduled_at), dedupeKey: `mail:${m!.id}` });
      return m!;
    });
  }

  async deliver(tenantId: string, messageId: string) {
    const prep = await this.db.tenantTx(tenantId, async (tx) => {
      const m = await one(tx, `SELECT * FROM mail_messages WHERE id=$1 FOR UPDATE`, [messageId]);
      if (!m || m.status !== 'queued') return null; // jamais de renvoi d'un message à l'état incertain
      const conn = m.connection_id ? await one(tx, `SELECT * FROM mail_connections WHERE id=$1`, [m.connection_id]) : null;
      const e = await this.ent.get(tenantId, tx);
      if (conn && (!e.features.includes('smtp.custom') || conn.status === 'disabled')) {
        // Pas de bascule silencieuse vers un autre expéditeur.
        await tx.query(`UPDATE mail_messages SET status='failed' WHERE id=$1`, [messageId]);
        await tx.query(`INSERT INTO mail_delivery_attempts(tenant_id, message_id, finished_at, outcome, smtp_response) VALUES ($1,$2,now(),'failed','Connexion SMTP indisponible ou option retirée')`, [tenantId, messageId]);
        return null;
      }
      await tx.query(`UPDATE mail_messages SET status='sending' WHERE id=$1`, [messageId]);
      const att = await one(tx, `INSERT INTO mail_delivery_attempts(tenant_id, message_id) VALUES ($1,$2) RETURNING id`, [tenantId, messageId]);
      const docs = [];
      for (const a of m.attachments) docs.push(await one(tx, `SELECT filename, mime, storage_key FROM documents WHERE id=$1`, [a.document_id]));
      return { m, conn, attemptId: att!.id, docs };
    });
    if (!prep) return;
    const { m, conn, attemptId, docs } = prep;
    let status: string, response: string;
    try {
      const attachments = await Promise.all(docs.map(async (d: any) => ({ filename: d.filename, contentType: d.mime, content: await this.storage.get(d.storage_key) })));
      if (conn) {
        const info = await (await this.transport(conn)).sendMail({
          messageId: m.message_id, from: { name: conn.from_name ?? '', address: conn.from_email }, replyTo: conn.reply_to ?? undefined,
          to: m.to_addresses, subject: m.subject, text: m.body_text, html: m.body_html ?? undefined, attachments,
        });
        response = String(info.response ?? '');
      } else {
        await this.system.send({ to: m.to_addresses.join(', '), subject: m.subject, text: m.body_text });
        response = 'platform';
      }
      status = 'accepted_by_smtp';
    } catch (e: any) {
      const preData = PRE_DATA_COMMANDS.includes(String(e.command ?? '')) || ['EAUTH', 'ETLS', 'EDNS', 'EENVELOPE'].includes(e.code);
      response = `${e.code ?? ''} ${e.command ?? ''} ${String(e.response ?? e.message).slice(0, 300)}`.trim();
      if (preData && TRANSIENT.includes(e.code)) {
        await this.finish(tenantId, messageId, attemptId, 'queued', response);
        throw new Error(`Erreur transitoire avant transmission : ${response}`); // nouvelle tentative par la file
      }
      status = preData ? 'failed' : 'delivery_unknown';
    }
    await this.finish(tenantId, messageId, attemptId, status, response);
  }

  private finish(tenantId: string, messageId: string, attemptId: number, status: string, response: string) {
    return this.db.tenantTx(tenantId, async (tx) => {
      await tx.query(`UPDATE mail_messages SET status=$2 WHERE id=$1`, [messageId, status]);
      await tx.query(`UPDATE mail_delivery_attempts SET finished_at=now(), outcome=$2, smtp_response=$3 WHERE id=$1`, [attemptId, status, response]);
    });
  }

  messages(ctx: RequestContext, q: { relatedId?: string; limit: number; offset: number }) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `SELECT id, connection_id, message_id, to_addresses, subject, status, related_type, related_id, scheduled_at, created_at,
       (SELECT json_agg(a ORDER BY a.started_at) FROM mail_delivery_attempts a WHERE a.message_id=m.id) attempts
       FROM mail_messages m WHERE ($1::uuid IS NULL OR related_id=$1) ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [q.relatedId ?? null, q.limit, q.offset]));
  }
}

