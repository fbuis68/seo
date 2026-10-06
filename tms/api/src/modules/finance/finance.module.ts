import { Body, Controller, Delete, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequestContext, RequirePermission } from '../../core/context';
import { isoDate, money, page, parse } from '../../core/validation';
import { CrmModule } from '../crm/crm.module';
import { EINVOICE_PROVIDER, FakeEInvoiceProvider } from './einvoice.provider';
import { FinanceService } from './finance.service';

const line = z.object({
  label: z.string().min(1).max(300),
  quantity: z.string().regex(/^-?\d{1,8}(\.\d{1,4})?$/),
  unitPriceHt: z.string().regex(/^-?\d{1,10}(\.\d{1,4})?$/),
  vatRate: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/),
});
const allocation = z.object({ invoiceId: z.string().uuid(), amount: money });

@Controller('api/v1')
export class FinanceController {
  constructor(private f: FinanceService) {}

  @RequirePermission('finance.read') @Get('invoices')
  list(@Ctx() c: RequestContext, @Query() q: unknown) { return this.f.listInvoices(c, parse(page.extend({ status: z.enum(['draft', 'issued']).optional(), clientId: z.string().uuid().optional() }), q)); }
  @RequirePermission('finance.read') @Get('invoices/:id') get(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.f.getInvoice(c, id); }
  @RequirePermission('finance.write') @Post('invoices')
  create(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.f.createInvoice(c, parse(z.object({
      clientId: z.string().uuid(), kind: z.enum(['invoice', 'deposit', 'credit_note']).default('invoice'), sessionId: z.string().uuid().nullable().optional(),
      lines: z.array(line).min(1).max(200), dueDate: isoDate.nullable().optional(), creditedInvoiceId: z.string().uuid().nullable().optional(),
      deductDepositIds: z.array(z.string().uuid()).max(10).optional(),
    }), b));
  }
  @RequirePermission('finance.write') @Patch('invoices/:id')
  update(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.f.updateDraft(c, id, parse(z.object({ lines: z.array(line).min(1).max(200), dueDate: isoDate.nullable().optional() }), b));
  }
  @RequirePermission('finance.write') @Delete('invoices/:id') del(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.f.deleteDraft(c, id); }
  /** Émission contrôlée : pas un simple changement de champ. */
  @RequirePermission('finance.write') @Post('invoices/:id/issue') issue(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.f.issue(c, id); }
  @RequirePermission('finance.write') @Post('invoices/:id/einvoice') einv(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.f.transmitEInvoice(c, id); }

  @RequirePermission('finance.read') @Get('payments') payments(@Ctx() c: RequestContext, @Query() q: unknown) { return this.f.listPayments(c, parse(page, q)); }
  @RequirePermission('finance.read') @Get('payments/:id') payment(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.f.getPayment(c, id); }
  @RequirePermission('finance.write') @Post('payments')
  pay(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.f.createPayment(c, parse(z.object({
      clientId: z.string().uuid(), amount: money, receivedOn: isoDate, method: z.enum(['transfer', 'card', 'check', 'cash', 'direct_debit', 'other']).optional(),
      reference: z.string().max(140).optional(), allocations: z.array(allocation).max(50).optional(),
    }), b));
  }
  @RequirePermission('finance.write') @Post('payments/:id/allocations')
  alloc(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.f.addAllocations(c, id, parse(z.object({ allocations: z.array(allocation).min(1) }), b).allocations); }

  @RequirePermission('finance.read') @Get('quotes') quotes(@Ctx() c: RequestContext) { return this.f.listQuotes(c); }
  @RequirePermission('finance.write') @Post('quotes')
  quote(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.f.createQuote(c, parse(z.object({ clientId: z.string().uuid(), sessionId: z.string().uuid().nullable().optional(), lines: z.array(line).min(1), validUntil: isoDate.nullable().optional() }), b));
  }
  @RequirePermission('finance.write') @Post('quotes/:id/status')
  quoteStatus(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.f.setQuoteStatus(c, id, parse(z.object({ status: z.enum(['sent', 'accepted', 'refused']) }), b).status); }
  @RequirePermission('finance.write') @Post('quotes/:id/invoice') toInvoice(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.f.quoteToInvoice(c, id); }
}

@Module({
  imports: [CrmModule],
  controllers: [FinanceController],
  providers: [FinanceService, { provide: EINVOICE_PROVIDER, useValue: new FakeEInvoiceProvider() }],
  exports: [FinanceService],
})
export class FinanceModule {}
