import { Body, Controller, Delete, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequestContext, RequirePermission } from '../../core/context';
import { isoDate, money, page, parse } from '../../core/validation';
import { PlanningService } from './planning.service';
import { SessionsService } from './sessions.service';
import { PlanningAdmin } from './planning/admin';
import { PlanningController } from './planning/planning.controller';
import { PlanningEngine } from './planning/engine';
import { PlanningQueries } from './planning/queries';

const sessionSchema = z.object({
  programVersionId: z.string().uuid(), kind: z.enum(['inter', 'intra']), clientId: z.string().uuid().nullable().optional(),
  title: z.string().max(200).optional(), capacity: z.number().int().positive().nullable().optional(), timezone: z.string().max(64).optional(),
  startsOn: isoDate.nullable().optional(), endsOn: isoDate.nullable().optional(), location: z.string().max(300).nullable().optional(),
  reference: z.string().max(60).nullable().optional(), minParticipants: z.number().int().min(0).nullable().optional(), siteId: z.string().uuid().nullable().optional(),
  responsible: z.string().max(200).nullable().optional(), targetMinutes: z.number().int().positive().nullable().optional(),
  requiredSkills: z.array(z.string().min(1).max(100)).max(30).optional(), requiredEquipment: z.array(z.string().min(1).max(100)).max(30).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(), internalNotes: z.string().max(5000).nullable().optional(),
  priceHt: money.nullable().optional(), priceBasis: z.enum(['per_learner', 'per_session']).nullable().optional(),
});
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Heure HH:MM attendue');

const slotSchema = z.object({
  startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }),
  partId: z.string().uuid().nullable().optional(),
  trainerIds: z.array(z.string().uuid()).max(20).optional(), resourceIds: z.array(z.string().uuid()).max(20).optional(),
  overrideReason: z.string().min(5).max(500).optional(),
});
const partSchema = z.object({ title: z.string().min(1).max(200), plannedMinutes: z.number().int().min(1).max(100000), notes: z.string().max(2000).nullable().optional() });
const resourceSchema = z.object({
  kind: z.enum(['site', 'room', 'equipment']), name: z.string().min(1).max(200), category: z.string().max(200).nullable().optional(),
  location: z.string().max(300).nullable().optional(), address: z.string().max(500).nullable().optional(), capacity: z.number().int().positive().nullable().optional(),
  serialNumber: z.string().max(100).nullable().optional(), inspectionDueOn: isoDate.nullable().optional(), notes: z.string().max(2000).nullable().optional(),
  siteId: z.string().uuid().nullable().optional(), equipment: z.array(z.string().min(1).max(100)).max(50).optional(), accessible: z.boolean().nullable().optional(),
  setupMinutes: z.number().int().min(0).max(1440).optional(), teardownMinutes: z.number().int().min(0).max(1440).optional(),
  openingHours: z.record(z.string().regex(/^[1-7]$/), z.array(z.tuple([hm, hm])).max(6)).nullable().optional(),
});

@Controller('api/v1')
export class SessionsController {
  constructor(private s: SessionsService, private planning: PlanningService) {}

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
    const p = parse(z.object({ status: z.enum(['draft', 'planned', 'confirmed', 'in_progress', 'completed', 'archived', 'cancelled']), reason: z.string().max(500).optional(), force: z.boolean().optional() }), b);
    return this.s.transition(c, id, p.status, p.reason, p.force);
  }
  @RequirePermission('sessions.read') @Get('sessions/:id/closure')
  closure(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.s.closure(c, id); }
  // ─── Planning : créneaux, parties, formateurs ───────────────────────────
  @RequirePermission('sessions.write') @Post('sessions/:id/slots')
  slot(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    const p = parse(slotSchema.extend({ roomId: z.string().uuid().nullable().optional(), trainerId: z.string().uuid().nullable().optional() }), b);
    // Compatibilité : trainerId / roomId uniques acceptés.
    return this.planning.addSlot(c, id, {
      ...p, trainerIds: p.trainerIds ?? (p.trainerId ? [p.trainerId] : []), resourceIds: p.resourceIds ?? (p.roomId ? [p.roomId] : []),
    });
  }
  @RequirePermission('sessions.write') @Patch('slots/:slotId')
  updateSlot(@Ctx() c: RequestContext, @Param('slotId', ParseUUIDPipe) slotId: string, @Body() b: unknown) {
    return this.planning.updateSlot(c, slotId, parse(slotSchema.partial().extend({ version: z.number().int().optional() }), b));
  }
  @RequirePermission('sessions.write') @Delete('slots/:slotId')
  deleteSlot(@Ctx() c: RequestContext, @Param('slotId', ParseUUIDPipe) slotId: string) { return this.planning.deleteSlot(c, slotId); }

  /** Formateur(s) après création : toute la session, une partie (partId) ou des créneaux (slotIds). */
  @RequirePermission('sessions.write') @Post('sessions/:id/trainer')
  trainer(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    const p = parse(z.object({
      trainerIds: z.array(z.string().uuid()).max(20).optional(), trainerId: z.string().uuid().nullable().optional(),
      slotIds: z.array(z.string().uuid()).max(500).optional(), partId: z.string().uuid().optional(),
      mode: z.enum(['replace', 'add', 'remove']).optional(), overrideReason: z.string().min(5).max(500).optional(),
    }), b);
    return this.planning.assignTrainers(c, id, { ...p, trainerIds: p.trainerIds ?? (p.trainerId ? [p.trainerId] : []) });
  }

  @RequirePermission('sessions.write') @Post('sessions/:id/parts')
  createPart(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.planning.createPart(c, id, parse(partSchema, b));
  }
  @RequirePermission('sessions.write') @Patch('session-parts/:partId')
  updatePart(@Ctx() c: RequestContext, @Param('partId', ParseUUIDPipe) partId: string, @Body() b: unknown) {
    return this.planning.updatePart(c, partId, parse(partSchema.partial().extend({ position: z.number().int().min(1).max(100).optional() }), b));
  }
  @RequirePermission('sessions.write') @Delete('session-parts/:partId')
  deletePart(@Ctx() c: RequestContext, @Param('partId', ParseUUIDPipe) partId: string) { return this.planning.deletePart(c, partId); }

  // ─── Ressources : lieux, salles, matériel ───────────────────────────────
  @RequirePermission('sessions.read') @Get('resources')
  resources(@Ctx() c: RequestContext, @Query() q: unknown) {
    return this.planning.listResources(c, parse(z.object({ kind: z.enum(['site', 'room', 'equipment']).optional(), archived: z.coerce.boolean().optional() }), q));
  }
  @RequirePermission('sessions.write') @Post('resources')
  createResource(@Ctx() c: RequestContext, @Body() b: unknown) { return this.planning.createResource(c, parse(resourceSchema, b)); }
  @RequirePermission('sessions.write') @Patch('resources/:rid')
  updateResource(@Ctx() c: RequestContext, @Param('rid', ParseUUIDPipe) rid: string, @Body() b: unknown) {
    return this.planning.updateResource(c, rid, parse(resourceSchema.omit({ kind: true }).partial(), b));
  }
  @RequirePermission('sessions.write') @Post('resources/:rid/archive')
  archiveResource(@Ctx() c: RequestContext, @Param('rid', ParseUUIDPipe) rid: string, @Body() b: unknown) {
    return this.planning.archiveResource(c, rid, parse(z.object({ archived: z.boolean().default(true) }), b).archived);
  }

  @RequirePermission('sessions.write') @Post('sessions/:id/enrollments')
  enroll(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.s.enroll(c, id, parse(z.object({
      personId: z.string().uuid(), clientId: z.string().uuid().nullable().optional(), status: z.enum(['provisional', 'confirmed']).optional(),
      fundedAmount: money.nullable().optional(), fundings: z.array(z.object({ funderClientId: z.string().uuid(), amount: money })).max(10).optional(),
      startsOn: isoDate.nullable().optional(), endsOn: isoDate.nullable().optional(), groupLabel: z.string().max(100).nullable().optional(),
    }), b));
  }
  /** Changement de groupe ou de dates d'entrée/sortie : séances futures revérifiées. */
  @RequirePermission('sessions.write') @Patch('enrollments/:id')
  updateEnrollment(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.s.updateEnrollment(c, id, parse(z.object({ startsOn: isoDate.nullable().optional(), endsOn: isoDate.nullable().optional(), groupLabel: z.string().max(100).nullable().optional(), clientId: z.string().uuid().nullable().optional() }), b));
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

@Module({
  controllers: [SessionsController, PlanningController],
  providers: [SessionsService, PlanningService, PlanningEngine, PlanningQueries, PlanningAdmin],
  exports: [SessionsService, PlanningService, PlanningEngine],
})
export class SessionsModule {}
