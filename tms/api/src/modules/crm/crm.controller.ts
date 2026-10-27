import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AllowReadOnly, Ctx, RequestContext, RequirePermission } from '../../core/context';
import { page, parse } from '../../core/validation';
import { CrmService } from './crm.service';

const personSchema = z.object({
  firstName: z.string().min(1).max(100), lastName: z.string().min(1).max(100),
  email: z.string().email().nullable().optional(), phone: z.string().max(30).nullable().optional(),
  roles: z.array(z.enum(['learner', 'trainer', 'contact', 'tutor', 'staff'])).min(1), skills: z.array(z.string().max(80)).max(50).optional(),
  email2: z.string().email().nullable().optional().or(z.literal('')), mobile: z.string().max(30).nullable().optional(), civility: z.string().max(20).nullable().optional(),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().or(z.literal('')), birthPlace: z.string().max(100).nullable().optional(),
  nationality: z.string().max(60).nullable().optional(), jobTitle: z.string().max(150).nullable().optional(), code: z.string().max(60).nullable().optional(),
  maidenName: z.string().max(100).nullable().optional(), address: z.record(z.string(), z.string().max(200)).optional(),
  employerClientId: z.string().uuid().nullable().optional().or(z.literal('')),
});
const clientSchema = z.object({
  kind: z.enum(['company', 'person']), name: z.string().min(1).max(200), status: z.enum(['prospect', 'customer']).optional(),
  isFunder: z.boolean().optional(), siren: z.string().nullable().optional(), siret: z.string().nullable().optional(),
  personId: z.string().uuid().nullable().optional(), billingEmail: z.string().email().nullable().optional().or(z.literal('')),
  billingAddress: z.record(z.string(), z.string()).optional(),
  phone: z.string().max(30).nullable().optional(), website: z.string().max(200).nullable().optional(), vatNumber: z.string().max(20).nullable().optional(),
  ape: z.string().max(10).nullable().optional(), code: z.string().max(60).nullable().optional(), paymentMethod: z.string().max(60).nullable().optional(),
});

@Controller('api/v1')
export class CrmController {
  constructor(private crm: CrmService) {}

  @RequirePermission('crm.read') @Get('persons')
  persons(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const p = parse(page.extend({ role: z.enum(['learner', 'trainer', 'contact', 'tutor', 'staff']).optional(), archived: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }), q);
    return this.crm.listPersons(ctx, p);
  }
  @RequirePermission('crm.write') @Post('persons')
  createPerson(@Ctx() ctx: RequestContext, @Body() b: unknown) { return this.crm.createPerson(ctx, parse(personSchema, b)); }
  @RequirePermission('crm.write') @Patch('persons/:id')
  updatePerson(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    const p = parse(personSchema.partial().extend({ version: z.number().int() }), b);
    return this.crm.updatePerson(ctx, id, p.version, p);
  }

  @RequirePermission('crm.write') @AllowReadOnly() @Post('persons/:id/archive')
  archivePerson(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.crm.archivePerson(ctx, id, parse(z.object({ archived: z.boolean().default(true) }), b).archived);
  }

  @RequirePermission('crm.read') @Get('clients')
  clients(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const p = parse(page.extend({ status: z.enum(['prospect', 'customer']).optional(), archived: z.coerce.boolean().optional() }), q);
    return this.crm.listClients(ctx, p);
  }
  @RequirePermission('crm.read') @Get('clients/:id')
  client(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.crm.getClient(ctx, id); }
  @RequirePermission('crm.write') @Post('clients')
  createClient(@Ctx() ctx: RequestContext, @Body() b: unknown) { return this.crm.createClient(ctx, parse(clientSchema, b)); }
  @RequirePermission('crm.write') @Patch('clients/:id')
  updateClient(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    const p = parse(clientSchema.partial().extend({ version: z.number().int() }), b);
    return this.crm.updateClient(ctx, id, p.version, p);
  }
  @RequirePermission('crm.write') @Post('clients/:id/promote')
  promote(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.crm.setStatus(ctx, id, 'customer'); }
  @RequirePermission('crm.write') @AllowReadOnly() @Post('clients/:id/archive')
  archive(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.crm.archiveClient(ctx, id, parse(z.object({ archived: z.boolean().default(true) }), b).archived);
  }
  @RequirePermission('crm.write') @AllowReadOnly() @Delete('clients/:id')
  remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.crm.deleteClient(ctx, id); }
  @RequirePermission('crm.write') @AllowReadOnly() @Post('clients/:id/merge')
  merge(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.crm.mergeClients(ctx, id, parse(z.object({ targetId: z.string().uuid() }), b).targetId);
  }
  @RequirePermission('crm.write') @Post('clients/:id/contacts')
  contact(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    const p = parse(z.object({ personId: z.string().uuid(), position: z.string().max(100).optional() }), b);
    return this.crm.addContact(ctx, id, p.personId, p.position);
  }
}
