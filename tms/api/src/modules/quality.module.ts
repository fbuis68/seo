import { Body, Controller, Get, Injectable, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequestContext, RequirePermission } from '../core/context';
import { Db, many, one } from '../core/db';
import { badRequest, notFound } from '../core/errors';
import { parse } from '../core/validation';

/**
 * Qualité simple : questionnaires, réponses individuelles (distinctes des synthèses importées),
 * réclamations et plan d'action. L'application organise les preuves ; la validation des
 * pratiques Qualiopi reste de la responsabilité de l'organisme.
 */
@Injectable()
export class QualityService {
  constructor(private db: Db) {}

  questionnaires(ctx: RequestContext) { return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `SELECT * FROM questionnaires ORDER BY title`)); }
  createQuestionnaire(ctx: RequestContext, b: { kind: string; title: string; questions: { id: string; label: string; type: 'score' | 'text' }[] }) {
    return this.db.tenantTx(ctx.tenantId, (tx) => one(tx, `INSERT INTO questionnaires(tenant_id, kind, title, questions) VALUES ($1,$2,$3,$4) RETURNING *`, [ctx.tenantId, b.kind, b.title, JSON.stringify(b.questions)]));
  }
  async respond(ctx: RequestContext, b: { questionnaireId: string; sessionId: string; enrollmentId?: string; answers: Record<string, string | number> }) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const q = await one(tx, `SELECT * FROM questionnaires WHERE id=$1`, [b.questionnaireId]);
      if (!q) throw notFound('Questionnaire');
      if (ctx.role === 'learner') {
        const e = await one(tx, `SELECT 1 FROM enrollments WHERE id=$1 AND person_id=$2 AND session_id=$3`, [b.enrollmentId, ctx.personId, b.sessionId]);
        if (!e) throw notFound('Inscription');
      }
      const scores = q.questions.filter((x: any) => x.type === 'score').map((x: any) => Number(b.answers[x.id])).filter((n: number) => n >= 0 && n <= 10);
      if (q.questions.some((x: any) => x.type === 'score' && b.answers[x.id] != null && !(Number(b.answers[x.id]) >= 0 && Number(b.answers[x.id]) <= 10))) throw badRequest('invalid_score', 'Notes de 0 à 10.');
      const score = scores.length ? (scores.reduce((a: number, n: number) => a + n, 0) / scores.length).toFixed(2) : null;
      return one(tx, `INSERT INTO questionnaire_responses(tenant_id, questionnaire_id, session_id, enrollment_id, answers, score) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ctx.tenantId, q.id, b.sessionId, b.enrollmentId ?? null, JSON.stringify(b.answers), score]);
    });
  }
  /** Synthèse : effectif de réponses et dénominateur affichés ; absence ≠ zéro. */
  summary(ctx: RequestContext, sessionId?: string) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `SELECT s.id session_id, s.title, count(r.id)::int responses,
        (SELECT count(*) FROM enrollments e WHERE e.session_id=s.id AND e.status<>'cancelled')::int enrolled,
        CASE WHEN count(r.score) > 0 THEN round(avg(r.score), 2)::text END avg_score
      FROM training_sessions s LEFT JOIN questionnaire_responses r ON r.session_id=s.id AND NOT r.is_imported_summary
      WHERE ($1::uuid IS NULL OR s.id=$1) GROUP BY s.id ORDER BY s.starts_on DESC NULLS LAST LIMIT 100`, [sessionId ?? null]));
  }
  complaints(ctx: RequestContext) { return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `SELECT * FROM complaints ORDER BY created_at DESC LIMIT 200`)); }
  createComplaint(ctx: RequestContext, b: { sessionId?: string; description: string }) {
    return this.db.tenantTx(ctx.tenantId, (tx) => one(tx, `INSERT INTO complaints(tenant_id, session_id, description) VALUES ($1,$2,$3) RETURNING *`, [ctx.tenantId, b.sessionId ?? null, b.description]));
  }
  updateComplaint(ctx: RequestContext, id: string, b: { status?: string; actionPlan?: string }) {
    return this.db.tenantTx(ctx.tenantId, (tx) => one(tx, `UPDATE complaints SET status=coalesce($2,status), action_plan=coalesce($3,action_plan) WHERE id=$1 RETURNING *`, [id, b.status ?? null, b.actionPlan ?? null]));
  }
}

@Controller('api/v1/quality')
export class QualityController {
  constructor(private q: QualityService) {}
  @RequirePermission('quality.read') @Get('questionnaires') list(@Ctx() c: RequestContext) { return this.q.questionnaires(c); }
  @RequirePermission('quality.write') @Post('questionnaires')
  create(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.q.createQuestionnaire(c, parse(z.object({ kind: z.enum(['satisfaction', 'evaluation', 'cold']), title: z.string().min(2).max(200),
      questions: z.array(z.object({ id: z.string().max(40), label: z.string().max(500), type: z.enum(['score', 'text']) })).min(1).max(50) }), b));
  }
  /** Réponse : gestionnaire (saisie) ou apprenant pour sa propre inscription. */
  @Post('responses')
  respond(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.q.respond(c, parse(z.object({ questionnaireId: z.string().uuid(), sessionId: z.string().uuid(), enrollmentId: z.string().uuid().optional(),
      answers: z.record(z.string(), z.union([z.string().max(5000), z.number()])) }), b));
  }
  @RequirePermission('quality.read') @Get('summary') summary(@Ctx() c: RequestContext, @Query('sessionId') s?: string) { return this.q.summary(c, s); }
  @RequirePermission('quality.read') @Get('complaints') complaints(@Ctx() c: RequestContext) { return this.q.complaints(c); }
  @RequirePermission('quality.write') @Post('complaints')
  complaint(@Ctx() c: RequestContext, @Body() b: unknown) { return this.q.createComplaint(c, parse(z.object({ sessionId: z.string().uuid().optional(), description: z.string().min(5).max(5000) }), b)); }
  @RequirePermission('quality.write') @Post('complaints/:id')
  updateComplaint(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.q.updateComplaint(c, id, parse(z.object({ status: z.enum(['open', 'in_progress', 'closed']).optional(), actionPlan: z.string().max(5000).optional() }), b));
  }
}

@Module({ controllers: [QualityController], providers: [QualityService] })
export class QualityModule {}
