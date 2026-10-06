import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequestContext, RequirePermission } from '../../core/context';
import { isoDate, money, page, parse } from '../../core/validation';
import { SessionsService } from './sessions.service';

const sessionSchema = z.object({
  programVersionId: z.string().uuid(), kind: z.enum(['inter', 'intra']), clientId: z.string().uuid().nullable().optional(),
  title: z.string().max(200).optional(), capacity: z.number().int().positive().nullable().optional(), timezone: z.string().max(64).optional(),
  startsOn: isoDate.nullable().optional(), endsOn: isoDate.nullable().optional(), location: z.string().max(300).nullable().optional(),
});

@Controller('api/v1')
export class SessionsController {
  constructor(private s: SessionsService) {}

  @RequirePermission('sessions.read') @Get('sessions')
  list(@Ctx() c: RequestContext, @Query() q: unknown) {
    return this.s.list(c, parse(page.extend({ status: z.string().optional(), from: isoDate.optional(), to: isoDate.optional() }), q));
  }
  @RequirePermission('sessions.read') @Get('sessions/:id') get(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.s.get(c, id); }
  @RequirePermission('sessions.write') @Post('sessions') create(@Ctx() c: RequestContext, @Body() b: unknown) { return this.s.create(c, parse(sessionSchema, b)); }
  @RequirePermission('sessions.write') @Patch('sessions/:id')
  update(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    const p = parse(sessionSchema.partial().extend({ version: z.number().int() }), b);
    return this.s.update(c, id, p.version, p);
  }
  @RequirePermission('sessions.write') @Post('sessions/:id/status')
  status(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    const p = parse(z.object({ status: z.enum(['draft', 'planned', 'confirmed', 'in_progress', 'completed', 'archived', 'cancelled']), reason: z.string().max(500).optional() }), b);
    return this.s.transition(c, id, p.status, p.reason);
  }
  @RequirePermission('sessions.write') @Post('sessions/:id/slots')
  slot(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.s.addSlot(c, id, parse(z.object({
      startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }),
      roomId: z.string().uuid().nullable().optional(), trainerId: z.string().uuid().nullable().optional(), overrideReason: z.string().min(5).max(500).optional(),
    }), b));
  }
  @RequirePermission('sessions.read') @Get('rooms') rooms(@Ctx() c: RequestContext) { return this.s.rooms(c); }
  @RequirePermission('sessions.write') @Post('rooms')
  room(@Ctx() c: RequestContext, @Body() b: unknown) { return this.s.createRoom(c, parse(z.object({ name: z.string().min(1).max(100), location: z.string().max(300).optional(), capacity: z.number().int().positive().optional() }), b)); }

  @RequirePermission('sessions.write') @Post('sessions/:id/enrollments')
  enroll(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.s.enroll(c, id, parse(z.object({
      personId: z.string().uuid(), clientId: z.string().uuid().nullable().optional(), status: z.enum(['provisional', 'confirmed']).optional(),
      fundedAmount: money.nullable().optional(), fundings: z.array(z.object({ funderClientId: z.string().uuid(), amount: money })).max(10).optional(),
    }), b));
  }
  @RequirePermission('sessions.write') @Post('enrollments/:id/status')
  enrollStatus(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    const p = parse(z.object({ status: z.enum(['confirmed', 'cancelled']), reason: z.string().max(500).optional() }), b);
    return this.s.setEnrollmentStatus(c, id, p.status, p.reason);
  }
  @RequirePermission('attendance.write') @Post('attendance')
  attendance(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.s.recordAttendance(c, parse(z.object({
      enrollmentId: z.string().uuid(), slotId: z.string().uuid(), status: z.enum(['present', 'absent', 'partial']), minutes: z.number().int().min(0).optional(),
    }), b));
  }
  @RequirePermission('sessions.read') @Get('sessions/:id/attendance')
  sheet(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.s.attendanceSheet(c, id); }
}

@Module({ controllers: [SessionsController], providers: [SessionsService], exports: [SessionsService] })
export class SessionsModule {}
