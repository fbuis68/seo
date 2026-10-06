import { Module } from '@nestjs/common';
import { config } from '../../config';
import { IdentityModule } from '../identity/identity.module';
import { BillingController, PaymentWebhookController } from './billing.controller';
import { DevCheckoutController } from './dev-checkout.controller';
import { PublicController } from './public.controller';
import { FakePaymentProvider } from './providers/fake.provider';
import { PAYMENT_PROVIDER } from './providers/payment-provider';
import { StripeProvider } from './providers/stripe.provider';
import { SubscriptionService } from './subscription.service';

@Module({
  imports: [IdentityModule],
  controllers: [PublicController, BillingController, PaymentWebhookController, DevCheckoutController],
  providers: [
    SubscriptionService,
    {
      provide: PAYMENT_PROVIDER,
      useFactory: () => config.payment.provider === 'stripe'
        ? new StripeProvider(config.payment.stripeSecretKey, config.payment.stripeWebhookSecret)
        : new FakePaymentProvider(config.payment.fakeWebhookSecret, config.publicApiUrl),
    },
  ],
  exports: [SubscriptionService],
})
export class BillingModule {}
