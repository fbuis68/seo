import { Body, Controller, Get, Header, Param, Post, Res } from '@nestjs/common';
import { config } from '../../config';
import { Public } from '../../core/context';
import { AppError } from '../../core/errors';
import { PLANS } from './catalog';
import { FakePaymentProvider } from './providers/fake.provider';
import { SubscriptionService } from './subscription.service';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Page de paiement simulée (PAYMENT_PROVIDER=fake) : hors production, ou en production
 * sur un serveur de démonstration explicitement déclaré (DEMO_PAYMENTS=true).
 * Cartes de test : 4242 4242 4242 4242 acceptée, 4000 0000 0000 0002 refusée.
 */
@Controller('api/v1/dev/fake-checkout')
export class DevCheckoutController {
  constructor(private subs: SubscriptionService) {}

  private get fake(): FakePaymentProvider {
    if ((config.isProd && !config.payment.demo) || !(this.subs.provider instanceof FakePaymentProvider)) throw new AppError(404, 'not_found', 'introuvable');
    return this.subs.provider;
  }

  @Public() @Get(':id') @Header('Content-Type', 'text/html; charset=utf-8')
  page(@Param('id') id: string) {
    const s = this.fake.sessions.get(id);
    if (!s) throw new AppError(404, 'not_found', 'Session inconnue');
    const label = s.kind === 'subscription' ? `Abonnement ${PLANS[s.plan!].name} (${s.interval === 'year' ? 'annuel' : 'mensuel'})` : 'Pack 20 signatures';
    return `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Paiement simulé</title><body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:16px">
<h1 style="font-size:20px">Paiement simulé</h1><p>${esc(label)}</p>
${s.addons.map((a) => `<p>Option : ${esc(a.code)} × ${a.quantity}</p>`).join('')}
<p style="color:#666">Environnement de démonstration : aucun paiement réel.</p>
<form method="post" style="display:grid;gap:8px">
<label>Numéro de carte (test)<br><input name="card" inputmode="numeric" autocomplete="off" value="4242 4242 4242 4242" style="width:100%;padding:8px;font:inherit"></label>
<div style="display:flex;gap:8px"><label>Expiration<br><input value="12/34" style="width:90px;padding:8px"></label><label>CVC<br><input value="123" style="width:70px;padding:8px"></label></div>
<p style="font-size:13px;color:#666;margin:0">4242 4242 4242 4242 : paiement accepté · 4000 0000 0000 0002 : carte refusée</p>
<button style="padding:10px 16px">Payer (simulation)</button></form>
<p><a href="${esc(s.cancelUrl)}">Annuler</a></p></body></html>`;
  }

  @Public() @Post(':id')
  async complete(@Param('id') id: string, @Body() body: any, @Res() res: any) {
    const s = this.fake.sessions.get(id);
    if (!s) throw new AppError(404, 'not_found', 'Session inconnue');
    const card = String(body?.card ?? '4242424242424242').replace(/\D/g, '');
    if (card !== '4242424242424242') {
      res.status(402).type('html').send(`<!doctype html><html lang="fr"><meta charset="utf-8"><title>Carte refusée</title><body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:16px">
<h1 style="font-size:20px">Carte refusée (simulation)</h1><p>Aucun débit, abonnement inchangé.</p><p><a href="./${esc(id)}">Réessayer</a> · <a href="${esc(s.cancelUrl)}">Retour</a></p></body></html>`);
      return;
    }
    for (const evt of this.fake.complete(id)) await this.subs.handleWebhook(evt.body, evt.headers);
    res.redirect(303, s.successUrl);
  }
}
