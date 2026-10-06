import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequestContext, RequireFeature, RequirePermission } from '../../core/context';
import { money, page, parse } from '../../core/validation';
import { FinanceModule } from '../finance/finance.module';
import { BANK_PROVIDER, FakeBankProvider } from './bank.provider';
import { BankService } from './bank.service';

@Controller('api/v1/bank')
export class BankController {
  constructor(private b: BankService) {}

  @RequireFeature('bank') @RequirePermission('bank.connect') @Post('connections') connect(@Ctx() c: RequestContext) { return this.b.startConnect(c); }
  @RequireFeature('bank') @RequirePermission('bank.connect') @Post('connections/callback')
  callback(@Ctx() c: RequestContext, @Body() body: unknown) { const p = parse(z.object({ code: z.string().min(4).max(500), state: z.string().min(10).max(200) }), body); return this.b.callback(c, p.code, p.state); }
  @RequirePermission('bank.read') @Get('connections') list(@Ctx() c: RequestContext) { return this.b.connections(c); }
  @RequireFeature('bank') @RequirePermission('bank.read') @Post('connections/:id/sync') sync(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.b.sync(c.tenantId, id); }
  @RequirePermission('bank.connect') @Post('connections/:id/disconnect') disconnect(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.b.disconnect(c, id); }

  @RequirePermission('bank.read') @Get('transactions')
  txs(@Ctx() c: RequestContext, @Query() q: unknown) { return this.b.transactions(c, parse(page.extend({ status: z.enum(['pending', 'booked', 'reversed']).optional(), unreconciled: z.coerce.boolean().optional() }), q)); }
  @RequirePermission('bank.reconcile') @Get('suggestions') suggestions(@Ctx() c: RequestContext) { return this.b.suggestions(c); }
  @RequirePermission('bank.reconcile') @Post('reconciliations')
  reconcile(@Ctx() c: RequestContext, @Body() body: unknown) {
    return this.b.reconcile(c, parse(z.object({ transactionId: z.string().uuid(), paymentId: z.string().uuid().optional(), clientId: z.string().uuid().optional(),
      allocations: z.array(z.object({ invoiceId: z.string().uuid(), amount: money })).max(50).optional() }), body));
  }
  @RequirePermission('bank.reconcile') @Post('reconciliations/:id/revert') revert(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.b.revert(c, id); }
}

@Module({
  imports: [FinanceModule],
  controllers: [BankController],
  providers: [BankService, { provide: BANK_PROVIDER, useValue: new FakeBankProvider() }],
  exports: [BankService],
})
export class BankModule {}
