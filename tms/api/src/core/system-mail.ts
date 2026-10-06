import { Injectable } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { config } from '../config';

export interface SystemMail { to: string; subject: string; text: string }

/**
 * Canal email système fiable (vérification, sécurité, factures d'abonnement).
 * Distinct du SMTP des clients : jamais de bascule silencieuse entre les deux.
 */
@Injectable()
export class SystemMailer {
  /** En développement/test sans SMTP : messages conservés en mémoire et journalisés. */
  readonly devOutbox: SystemMail[] = [];
  private transport?: Transporter;

  constructor() {
    if (config.smtpSystem.url) this.transport = nodemailer.createTransport(config.smtpSystem.url);
  }

  async send(mail: SystemMail): Promise<void> {
    if (!this.transport) {
      this.devOutbox.push(mail);
      if (this.devOutbox.length > 200) this.devOutbox.shift();
      if (process.env.NODE_ENV !== 'test') console.log(`[mail système] à ${mail.to} : ${mail.subject}\n${mail.text}`);
      return;
    }
    await this.transport.sendMail({ from: config.smtpSystem.from, ...mail });
  }
}
