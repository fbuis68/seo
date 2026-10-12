import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Ctx, RequestContext, RequirePermission } from '../../../core/context';
import { forbidden } from '../../../core/errors';
import { isoDate, parse } from '../../../core/validation';
import { PlanningAdmin } from './admin';
import { PlanningEngine, WriteOpts } from './engine';
import { PlanningQueries } from './queries';

const instant = z.string().datetime({ offset: true });
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Heure HH:MM attendue');
const weekly = z.record(z.string().regex(/^[1-7]$/), z.array(z.tuple([hm, hm])).max(6)).nullable();
const breaks = z.array(z.object({ startsAt: instant, endsAt: instant })).max(10);
const trainers = z.array(z.object({ id: z.string().uuid(), role: z.enum(['lead', 'co']).optional() })).max(20);
const participants = z.array(z.object({ enrollmentId: z.string().uuid(), mode: z.enum(['onsite', 'remote', 'excluded', 'default']) })).max(500);
const fields = z.object({
  startsAt: instant.optional(), endsAt: instant.optional(), title: z.string().max(200).nullable().optional(), partId: z.string().uuid().nullable().optional(),
  modality: z.enum(['onsite', 'remote', 'hybrid']).optional(), videoUrl: z.string().url().max(500).nullable().optional(), breaks: breaks.optional(),
  groupLabel: z.string().max(100).nullable().optional(), notes: z.string().max(2000).nullable().optional(),
  trainers: trainers.optional(), trainerIds: z.array(z.string().uuid()).max(20).optional(), resourceIds: z.array(z.string().uuid()).max(20).optional(),
  participants: participants.optional(),
});
/** Options d'écriture : prévisualisation, dérogation motivée, motif. */
const write = z.object({ preview: z.boolean().optional(), derogation: z.string().min(5).max(500).optional(), reason: z.string().min(3).max(500).optional() });

type Fields = z.infer<typeof fields>;
const toFields = ({ trainerIds, ...f }: Fields) => ({ ...f, trainers: f.trainers ?? (trainerIds ? trainerIds.map((id) => ({ id })) : undefined) });
const opts = (b: z.infer<typeof write>, key?: string): WriteOpts => ({ preview: b.preview, derogation: b.derogation, reason: b.reason, idempotencyKey: key?.slice(0, 200) });

const slotQuery = z.object({
  from: instant, to: instant, sessionId: z.string().uuid().optional(), trainerId: z.string().uuid().optional(), resourceId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(), learnerId: z.string().uuid().optional(), programId: z.string().uuid().optional(), status: z.string().max(80).optional(),
  modality: z.enum(['onsite', 'remote', 'hybrid']).optional(), groupLabel: z.string().max(100).optional(), q: z.string().max(100).optional(),
  incomplete: z.enum(['true', 'false']).transform((v) => v === 'true').optional(), withLearners: z.enum(['true', 'false']).transform((v) => v === 'true').optional(), limit: z.coerce.number().int().min(1).max(5000).optional(),
});
const range = z.object({ from: instant, to: instant });

/**
 * API planning : lecture par intervalle et filtres, écritures validées (version attendue,
 * en-tête Idempotency-Key, résultat de contrôle structuré), événements sortants.
 */
@Controller('api/v1/planning')
export class PlanningController {
  constructor(private engine: PlanningEngine, private q: PlanningQueries, private admin: PlanningAdmin) {}

  // ─── Lecture ────────────────────────────────────────────────────────────
  @RequirePermission('sessions.read') @Get('slots')
  slots(@Ctx() c: RequestContext, @Query() query: unknown) { return this.q.slots(c, parse(slotQuery, query)); }
  @RequirePermission('sessions.read') @Get('slots/:id')
  slot(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.q.slot(c, id); }
  @RequirePermission('sessions.read') @Get('lookups')
  lookups(@Ctx() c: RequestContext) { return this.q.lookups(c); }
  /** Portail personnel formateur / stagiaire (aucune permission de gestion requise). */
  @Get('me')
  me(@Ctx() c: RequestContext, @Query() query: unknown) { return this.q.me(c, parse(range, query)); }
  @Get('me.ics')
  async meIcs(@Ctx() c: RequestContext, @Query() query: unknown, @Res() res: Response) {
    res.type('text/calendar; charset=utf-8').setHeader('Content-Disposition', 'attachment; filename="mon-planning.ics"');
    res.send(await this.q.meIcs(c, parse(range, query)));
  }
  @RequirePermission('sessions.write') @Get('conflicts')
  conflicts(@Ctx() c: RequestContext, @Query() query: unknown) { return this.q.conflicts(c, parse(range, query)); }
  @RequirePermission('sessions.read') @Get('indicators')
  indicators(@Ctx() c: RequestContext, @Query() query: unknown) {
    if (c.role === 'trainer') throw forbidden('permission_denied', 'Indicateurs réservés à la direction et aux gestionnaires.');
    return this.q.indicators(c, parse(range, query));
  }
  @RequirePermission('sessions.read') @Get('history')
  history(@Ctx() c: RequestContext, @Query() query: unknown) {
    if (c.role === 'trainer') throw forbidden('permission_denied', 'Journal réservé aux gestionnaires.');
    return this.q.history(c, parse(z.object({ slotId: z.string().uuid().optional(), sessionId: z.string().uuid().optional(), limit: z.coerce.number().int().max(1000).optional() }), query));
  }
  @RequirePermission('sessions.read') @Get('events')
  events(@Ctx() c: RequestContext, @Query() query: unknown) {
    if (c.role === 'trainer') throw forbidden('permission_denied', 'Flux réservé aux intégrations.');
    return this.q.events(c, parse(z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().max(1000).optional() }), query));
  }
  @RequirePermission('sessions.write') @Post('check')
  check(@Ctx() c: RequestContext, @Body() b: unknown) {
    const p = parse(fields.extend({ slotId: z.string().uuid().optional(), sessionId: z.string().uuid().optional() }), b);
    return this.q.check(c, { ...toFields(p), slotId: p.slotId, sessionId: p.sessionId });
  }
  @RequirePermission('sessions.write') @Post('suggest')
  suggest(@Ctx() c: RequestContext, @Body() b: unknown) {
    const p = parse(fields.extend({ slotId: z.string().uuid().optional(), sessionId: z.string().uuid(), startsAt: instant, endsAt: instant, kind: z.enum(['trainer', 'room', 'equipment', 'slot']) }), b);
    return this.q.suggest(c, { ...toFields(p), slotId: p.slotId, sessionId: p.sessionId, kind: p.kind, startsAt: p.startsAt, endsAt: p.endsAt });
  }

  // ─── Exports ────────────────────────────────────────────────────────────
  @RequirePermission('sessions.read') @Get('export.csv')
  async csv(@Ctx() c: RequestContext, @Query() query: unknown, @Res() res: Response) {
    res.type('text/csv; charset=utf-8').setHeader('Content-Disposition', 'attachment; filename="planning.csv"');
    res.send(await this.q.exportCsv(c, parse(slotQuery, query)));
  }
  @RequirePermission('sessions.read') @Get('export.pdf')
  async pdf(@Ctx() c: RequestContext, @Query() query: unknown, @Res() res: Response) {
    const p = parse(slotQuery.extend({ groupBy: z.enum(['session', 'trainer', 'room', 'group']).optional() }), query);
    res.type('application/pdf').setHeader('Content-Disposition', 'attachment; filename="planning.pdf"');
    res.send(await this.q.exportPdf(c, p));
  }
  @RequirePermission('sessions.read') @Get('export.ics')
  async icsExport(@Ctx() c: RequestContext, @Query() query: unknown, @Res() res: Response) {
    res.type('text/calendar; charset=utf-8').setHeader('Content-Disposition', 'attachment; filename="planning.ics"');
    res.send(await this.q.exportIcs(c, parse(slotQuery, query)));
  }

  // ─── Écritures ──────────────────────────────────────────────────────────
  @RequirePermission('sessions.write') @Post('slots')
  create(@Ctx() c: RequestContext, @Body() b: unknown, @Headers('idempotency-key') key?: string) {
    const p = parse(fields.merge(write).extend({ sessionId: z.string().uuid(), startsAt: instant, endsAt: instant, status: z.enum(['draft', 'pending', 'published']).optional() }), b);
    return this.engine.create(c, p.sessionId, { ...toFields(p), startsAt: p.startsAt, endsAt: p.endsAt, status: p.status }, opts(p, key));
  }
  @RequirePermission('sessions.write') @Patch('slots/:id')
  update(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown, @Headers('idempotency-key') key?: string) {
    const p = parse(fields.merge(write).extend({ version: z.number().int().optional(), scope: z.enum(['this', 'following', 'all']).optional() }), b);
    return this.engine.update(c, id, { ...toFields(p), version: p.version, scope: p.scope }, opts(p, key));
  }
  @RequirePermission('sessions.write') @Post('slots/:id/duplicate')
  duplicate(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown, @Headers('idempotency-key') key?: string) {
    const p = parse(write.extend({ dates: z.array(isoDate).min(1).max(100), keepTrainers: z.boolean().optional(), keepResources: z.boolean().optional() }), b);
    return this.engine.duplicate(c, id, p, opts(p, key));
  }
  @RequirePermission('sessions.write') @Post('slots/:id/cancel')
  cancel(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown, @Headers('idempotency-key') key?: string) {
    const p = parse(write.extend({ reason: z.string().min(3).max(500) }), b);
    return this.engine.cancel(c, [id], p.reason, opts(p, key));
  }
  @RequirePermission('sessions.write') @Delete('slots/:id')
  remove(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.engine.remove(c, id); }
  @RequirePermission('sessions.write') @Put('slots/:id/participants')
  participants(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    const p = parse(write.extend({ participants, version: z.number().int().optional() }), b);
    return this.engine.participants(c, id, p, opts(p));
  }
  @RequirePermission('sessions.write') @Post('bulk')
  bulk(@Ctx() c: RequestContext, @Body() b: unknown, @Headers('idempotency-key') key?: string) {
    const p = parse(write.extend({
      slotIds: z.array(z.string().uuid()).min(1).max(500), shiftDays: z.number().int().min(-366).max(366).optional(), shiftMinutes: z.number().int().min(-1440).max(1440).optional(),
      trainers: z.object({ ids: z.array(z.string().uuid()).max(20), mode: z.enum(['replace', 'add', 'remove']), role: z.enum(['lead', 'co']).optional() }).optional(),
      resources: z.object({ ids: z.array(z.string().uuid()).max(20), mode: z.enum(['replace', 'add', 'remove']) }).optional(),
      modality: z.enum(['onsite', 'remote', 'hybrid']).optional(), videoUrl: z.string().url().max(500).nullable().optional(), groupLabel: z.string().max(100).nullable().optional(),
    }), b);
    return this.engine.bulk(c, p, opts(p, key));
  }
  @RequirePermission('sessions.write') @Post('sessions/:id/shift')
  shift(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown, @Headers('idempotency-key') key?: string) {
    const p = parse(write.extend({ days: z.number().int().min(-366).max(366).refine((d) => d !== 0), slotIds: z.array(z.string().uuid()).max(500).optional() }), b);
    return this.engine.shiftSession(c, id, p, opts(p, key));
  }
  @RequirePermission('sessions.write') @Post('sessions/:id/series')
  series(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown, @Headers('idempotency-key') key?: string) {
    const p = parse(fields.omit({ startsAt: true, endsAt: true, breaks: true }).merge(write).extend({
      startDate: isoDate, days: z.array(z.number().int().min(1).max(7)).min(1).max(7), intervalWeeks: z.number().int().min(1).max(8).optional(),
      until: isoDate.optional(), count: z.number().int().min(1).max(366).optional(), startTime: hm, endTime: hm,
      exclusions: z.array(isoDate).max(366).optional(), breaks: z.array(z.object({ start: hm, end: hm })).max(5).optional(), partial: z.boolean().optional(),
    }), b);
    const { preview, derogation, reason, trainerIds, ...rule } = p;
    return this.engine.series(c, id, { ...rule, trainers: p.trainers ?? trainerIds?.map((t) => ({ id: t })) }, opts({ preview, derogation, reason }, key));
  }
  /** Workflow : à valider, publier, réaliser, renvoyer en brouillon (séances ou session entière). */
  @RequirePermission('sessions.write') @Post('transition')
  transition(@Ctx() c: RequestContext, @Body() b: unknown, @Headers('idempotency-key') key?: string) {
    const p = parse(write.extend({ status: z.enum(['draft', 'pending', 'published', 'done']), slotIds: z.array(z.string().uuid()).max(500).optional(), sessionId: z.string().uuid().optional() })
      .refine((x) => x.slotIds?.length || x.sessionId, 'slotIds ou sessionId requis'), b);
    return this.engine.transition(c, p, opts(p, key));
  }
  @RequirePermission('sessions.write') @Post('import')
  import(@Ctx() c: RequestContext, @Body() b: unknown, @Headers('idempotency-key') key?: string) {
    const p = parse(write.extend({ csv: z.string().max(5_000_000).optional(), fileBase64: z.string().max(14_000_000).optional(), filename: z.string().max(200).optional(),
      mapping: z.record(z.string(), z.string().max(100)).optional(), partial: z.boolean().optional() }), b);
    return this.admin.import(c, p, opts(p, key));
  }

  // ─── Disponibilités, fermetures, profils, paramètres ───────────────────
  @RequirePermission('sessions.read') @Get('availabilities')
  availabilities(@Ctx() c: RequestContext, @Query() query: unknown) {
    return this.admin.availabilities(c, parse(z.object({ ownerId: z.string().uuid().optional(), from: instant.optional(), to: instant.optional(), status: z.enum(['pending', 'approved', 'rejected']).optional() }), query));
  }
  @RequirePermission('sessions.read') @Post('availabilities')
  createAvailability(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.admin.createAvailability(c, parse(z.object({ ownerType: z.enum(['person', 'resource']), ownerId: z.string().uuid(), kind: z.enum(['unavailable', 'available']),
      startsAt: instant, endsAt: instant, reason: z.string().max(300).nullable().optional() }), b));
  }
  @RequirePermission('sessions.write') @Post('availabilities/:id/decision')
  decide(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.admin.decideAvailability(c, id, parse(z.object({ status: z.enum(['approved', 'rejected']) }), b).status);
  }
  @RequirePermission('sessions.read') @Delete('availabilities/:id')
  deleteAvailability(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.admin.deleteAvailability(c, id); }

  @RequirePermission('sessions.read') @Get('closures')
  closures(@Ctx() c: RequestContext) { return this.admin.closures(c); }
  @RequirePermission('sessions.write') @Post('closures')
  createClosure(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.admin.createClosure(c, parse(z.object({ siteId: z.string().uuid().nullable().optional(), startsOn: isoDate, endsOn: isoDate, label: z.string().min(1).max(200) }), b));
  }
  @RequirePermission('sessions.write') @Delete('closures/:id')
  deleteClosure(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.admin.deleteClosure(c, id); }

  @RequirePermission('sessions.read') @Get('trainers/:personId/profile')
  profile(@Ctx() c: RequestContext, @Param('personId', ParseUUIDPipe) personId: string) { return this.admin.profile(c, personId); }
  @RequirePermission('sessions.write') @Put('trainers/:personId/profile')
  saveProfile(@Ctx() c: RequestContext, @Param('personId', ParseUUIDPipe) personId: string, @Body() b: unknown) {
    return this.admin.saveProfile(c, personId, parse(z.object({
      status: z.enum(['internal', 'external']).optional(), allowedSiteIds: z.array(z.string().uuid()).max(50).optional(), workingHours: weekly.optional(),
      maxWeeklyMinutes: z.number().int().min(1).max(10080).nullable().optional(), travelMinutes: z.number().int().min(0).max(1440).optional(), active: z.boolean().optional(),
      skills: z.array(z.string().min(1).max(100)).max(50).optional(),
    }), b));
  }

  @RequirePermission('sessions.read') @Get('settings')
  settings(@Ctx() c: RequestContext) { return this.admin.settings(c); }
  @RequirePermission('org.manage') @Put('settings')
  saveSettings(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.admin.saveSettings(c, parse(z.object({
      grid_step: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30), z.literal(60)]).optional(), day_start: hm.optional(), day_end: hm.optional(),
      workdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(), direct_publish: z.boolean().optional(), overlap_derogable: z.boolean().optional(),
      max_daily_minutes: z.number().int().min(60).max(1440).optional(), default_weekly_minutes: z.number().int().min(60).max(10080).optional(),
      short_notice_hours: z.number().int().min(0).max(720).optional(), unusual_before: hm.optional(), unusual_after: hm.optional(),
    }), b));
  }
}
