import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, Sse } from '@nestjs/common';
import QRCode from 'qrcode';
import { Observable, interval, map, merge } from 'rxjs';
import { config } from '../../config';
import { AccessService } from '../../core/access';
import { Ctx, MaybeCtx, OptionalAuth, Public, RequestContext } from '../../core/context';
import { toCsv } from '../../core/csv';
import { Db, many } from '../../core/db';
import { badRequest, notFound, paymentRequired } from '../../core/errors';
import { hasFeature, PLANS } from '../../core/plans';
import { LiveEvents } from '../../core/services';
import { xlsxBuffer } from '../../core/xlsx';
import { DISCIPLINE_PRESETS } from '../../engine/scoring';
import { TIEBREAKER_LABELS } from '../../engine/standings';
import { FORMATS } from './generation';
import { MatchesService } from './matches';
import { ParticipantsService } from './participants';
import { ResultsService } from './results';
import { loadState } from './state';
import { suggestFormat, TournamentsService } from './tournaments';
import { matchView, tournamentView } from './views';

@Controller('api')
export class CatalogController {
  /** Référentiels de l'assistant de création. */
  @Public() @Get('catalog') catalog() {
    return {
      disciplines: Object.entries(DISCIPLINE_PRESETS).map(([key, v]) => ({ key, ...v })),
      formats: Object.entries(FORMATS).map(([key, v]) => ({ key, label: v.label })),
      tiebreakers: Object.entries(TIEBREAKER_LABELS).map(([key, label]) => ({ key, label })),
      plans: PLANS,
    };
  }
  @Public() @Get('catalog/suggest-format') suggest(@Query('participants') n: string) { return suggestFormat(Math.max(2, Number(n) || 8)); }
}

@Controller('api')
export class TournamentsController {
  constructor(private s: TournamentsService, private p: ParticipantsService, private db: Db, private access: AccessService, private live: LiveEvents) {}

  @Post('tournaments') create(@Ctx() c: RequestContext, @Body() b: unknown) { return this.s.create(c, b); }
  @Get('tournaments') list(@Ctx() c: RequestContext, @Query('orgId') orgId: string) {
    if (!orgId) throw badRequest('org_required', 'orgId requis');
    return this.s.list(c, orgId);
  }
  @OptionalAuth() @Get('tournaments/:id') get(@MaybeCtx() c: RequestContext | undefined, @Param('id') id: string) { return this.s.view(c, id); }
  @Patch('tournaments/:id') update(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.s.update(c, id, b); }
  @Delete('tournaments/:id') remove(@Ctx() c: RequestContext, @Param('id') id: string) { return this.s.remove(c, id); }
  @Post('tournaments/:id/publish') publish(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.s.publish(c, id, b); }
  @Post('tournaments/:id/generate') generate(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.s.generate(c, id, b); }
  @Post('tournaments/:id/schedule') reschedule(@Ctx() c: RequestContext, @Param('id') id: string) { return this.s.reschedule(c, id); }
  @Get('tournaments/:id/dashboard') dashboard(@Ctx() c: RequestContext, @Param('id') id: string) { return this.s.dashboard(c, id); }
  @Get('tournaments/:id/stats') stats(@Ctx() c: RequestContext, @Param('id') id: string) { return this.s.stats(c, id); }
  @Get('tournaments/:id/audit') audit(@Ctx() c: RequestContext, @Param('id') id: string, @Query('entityId') e?: string) { return this.s.audit(c, id, e); }
  @Get('tournaments/:id/integrity') integrity(@Ctx() c: RequestContext, @Param('id') id: string) { return this.s.integrity(c, id); }
  @Post('tournaments/:id/stages/:stageId/tiebreak') tiebreak(@Ctx() c: RequestContext, @Param('id') id: string, @Param('stageId') st: string, @Body() b: unknown) { return this.s.tiebreak(c, id, st, b); }

  @OptionalAuth() @Get('tournaments/:id/bracket') async bracket(@MaybeCtx() c: RequestContext | undefined, @Param('id') id: string) {
    const v = await this.s.view(c, id);
    return { stages: v.stages, matches: v.matches.filter((m: any) => m.stageKind === 'knockout') };
  }
  @OptionalAuth() @Get('tournaments/:id/matches') async matches(@MaybeCtx() c: RequestContext | undefined, @Param('id') id: string) { return (await this.s.view(c, id)).matches; }
  @OptionalAuth() @Get('tournaments/:id/rankings') async rankings(@MaybeCtx() c: RequestContext | undefined, @Param('id') id: string) {
    const v = await this.s.view(c, id);
    return { groups: v.stages.filter((s: any) => s.groups).map((s: any) => ({ stageId: s.id, name: s.name, groups: s.groups })), final: v.ranking };
  }
  @OptionalAuth() @Get('tournaments/:id/results') async results(@MaybeCtx() c: RequestContext | undefined, @Param('id') id: string) {
    return (await this.s.view(c, id)).matches.filter((m: any) => ['completed', 'walkover'].includes(m.status));
  }

  // Participants
  @Get('tournaments/:id/participants') participants(@Ctx() c: RequestContext, @Param('id') id: string) { return this.p.list(c, id); }
  @Post('tournaments/:id/participants') addParticipant(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.p.add(c, id, b); }
  @Post('tournaments/:id/registrations') register(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.p.add(c, id, b); }
  @Post('tournaments/:id/participants/import') importCsv(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.p.importCsv(c, id, b); }
  @Patch('participants/:id') updateParticipant(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.p.update(c, id, b); }
  @Post('participants/:id/status') participantStatus(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.p.setStatus(c, id, b); }
  @Post('participants/:id/replace') replace(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.p.replace(c, id, b); }
  @Delete('participants/:id') removeParticipant(@Ctx() c: RequestContext, @Param('id') id: string) { return this.p.remove(c, id); }
  @Post('members/:id/invite') invite(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.p.inviteMember(c, id, b); }
  @Post('members/:id/claim-decision') decideClaim(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.p.decideClaim(c, id, b); }
  @Post('tournaments/:id/claim-requests') requestClaim(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.p.requestClaim(c, id, b); }
  @Get('organizations/:id/players') players(@Ctx() c: RequestContext, @Param('id') id: string, @Query('q') q?: string) { return this.p.knownPlayers(c, id, q); }

  // Rôles
  @Get('tournaments/:id/roles') roles(@Ctx() c: RequestContext, @Param('id') id: string) { return this.s.roles(c, id); }
  @Post('tournaments/:id/referees') addReferee(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: any) { return this.s.addRole(c, id, { ...b, role: 'referee' }); }
  @Post('tournaments/:id/roles') addRole(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.s.addRole(c, id, b); }
  @Delete('tournaments/:id/roles/:userId/:role') removeRole(@Ctx() c: RequestContext, @Param('id') id: string, @Param('userId') u: string, @Param('role') r: string) { return this.s.removeRole(c, id, u, r); }

  // QR Codes
  @Post('tournaments/:id/qr-codes') async qr(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: any) {
    return this.access.asOrganizer(c, id, async (tx, a) => {
      const t = (await many(tx, 'SELECT slug FROM tournaments WHERE id = $1', [id]))[0];
      const token = await this.p.tournamentToken(tx, a, c.userId, !!b?.rotate);
      return {
        registration: { token, url: `${config.appUrl}/join/${token}` },
        public: { url: `${config.appUrl}/p/${t.slug}` },
      };
    });
  }
  @Get('tournaments/:id/qr-codes') tokens(@Ctx() c: RequestContext, @Param('id') id: string) { return this.p.listTokens(c, id); }
  @Delete('tournaments/:id/qr-codes/:tokenId') revoke(@Ctx() c: RequestContext, @Param('id') id: string, @Param('tokenId') t: string) { return this.p.revokeToken(c, id, t); }
  @Post('tournaments/:id/matches/:matchId/qr') async matchQr(@Ctx() c: RequestContext, @Param('id') id: string, @Param('matchId') mid: string) {
    return this.access.asOrganizer(c, id, async (tx, a) => {
      if (!(await many(tx, 'SELECT 1 FROM matches WHERE id = $1 AND tournament_id = $2', [mid, id])).length) throw notFound('Rencontre');
      const token = await ParticipantsService.createToken(tx, a, 'match', mid, c.userId, 7);
      return { token, url: `${config.appUrl}/join/${token}` };
    });
  }

  // Exports (§12.1)
  @Get('tournaments/:id/export/:what') async export(@Ctx() c: RequestContext, @Param('id') id: string, @Param('what') what: string, @Res() res: any) {
    const [kind, ext] = what.split('.');
    if (!['participants', 'results', 'ranking', 'planning'].includes(kind) || !['csv', 'xlsx'].includes(ext)) throw notFound('Export');
    const { rows, name, plan } = await this.access.asOrganizer(c, id, async (tx, a) => {
      const s = await loadState(tx, id);
      const plan = (await many(tx, 'SELECT plan FROM organizations WHERE id = $1', [a.orgId]))[0].plan;
      const v = tournamentView(s);
      let rows: string[][] = [];
      if (kind === 'participants') {
        const members = await many(tx, 'SELECT participant_id, first_name, last_name, email, phone FROM participant_members WHERE tournament_id = $1 ORDER BY position', [id]);
        rows = [['Participant', 'Statut', 'Club', 'Catégorie', 'Niveau', 'Tête de série', 'Présent', 'Joueurs', 'Emails', 'Téléphones']];
        for (const p of s.participants) {
          const ms = members.filter((m) => m.participant_id === p.id);
          rows.push([p.name, p.status, p.club ?? '', p.category ?? '', p.rating == null ? '' : String(p.rating), p.seed == null ? '' : String(p.seed), p.checked_in_at ? 'oui' : 'non',
            ms.map((m) => `${m.first_name} ${m.last_name}`).join(' / '), ms.map((m) => m.email ?? '').join(' / '), ms.map((m) => m.phone ?? '').join(' / ')]);
        }
      } else if (kind === 'results' || kind === 'planning') {
        rows = [['Phase', 'Tour', 'Rencontre', 'Terrain', 'Horaire', 'Domicile', 'Extérieur', 'Score', 'Vainqueur', 'Statut']];
        const list = v.matches.filter((m) => m.status !== 'bye' && (kind === 'planning' || ['completed', 'walkover'].includes(m.status)));
        if (kind === 'planning') list.sort((x, y) => String(x.scheduledAt ?? '9').localeCompare(String(y.scheduledAt ?? '9')) || (x.court ?? 0) - (y.court ?? 0));
        for (const m of list) {
          const sc = m.score?.sets ? m.score.sets.map((x: any) => `${x.home}-${x.away}`).join(' ') : m.score ? `${m.score.home}-${m.score.away}` : '';
          rows.push([m.stageName ?? '', m.roundLabel, m.key, m.court ? String(m.court) : '', m.scheduledAt ? new Date(m.scheduledAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) : '',
            m.home.name, m.away.name, sc, m.isDraw ? 'Nul' : m.winnerId === m.home.id ? m.home.name : m.winnerId === m.away.id ? m.away.name : '', m.statusLabel]);
        }
      } else {
        rows = [['Rang', 'Participant', 'Ex æquo', 'Parcours']];
        for (const r of v.ranking.rows) rows.push([String(r.rank), r.name, r.tied ? 'oui' : '', r.reached ?? '']);
      }
      return { rows, name: `${s.t.slug}-${kind}`, plan };
    });
    if (ext === 'xlsx') {
      if (!hasFeature(plan, 'exports')) throw paymentRequired('feature_not_in_plan', 'Export Excel : disponible à partir de l’offre Club (CSV disponible).');
      const buf = await xlsxBuffer([{ name: kind, rows }]);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
      return res.send(buf);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    return res.send(toCsv(rows));
  }

  /** Flux temps réel organisateur/joueur (jeton en paramètre : EventSource ne transmet pas d'en-tête). */
  @Sse('tournaments/:id/stream') async stream(@Ctx() c: RequestContext, @Param('id') id: string): Promise<Observable<any>> {
    await this.s.view(c, id); // contrôle d'accès
    return merge(this.live.stream([id]), interval(25_000).pipe(map(() => ({ type: 'ping', data: {} }))));
  }
}

@Controller('api/matches')
export class MatchesController {
  constructor(private m: MatchesService, private r: ResultsService) {}
  @OptionalAuth() @Get(':id') detail(@MaybeCtx() c: RequestContext | undefined, @Param('id') id: string) { return this.m.detail(c, id); }
  @Patch(':id/schedule') schedule(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.m.schedule(c, id, b); }
  @Post(':id/status') status(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.m.setStatus(c, id, b); }
  @Post(':id/penalty') penalty(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.m.penalty(c, id, b); }
  @Post(':id/scores') submit(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.r.submit(c, id, b); }
  @Post(':id/confirm-score') confirm(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.r.confirm(c, id, b); }
  @Post(':id/dispute-score') dispute(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.r.dispute(c, id, b); }
  @Post(':id/validate-score') validate(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.r.validate(c, id, b); }
  @Post(':id/walkover') walkover(@Ctx() c: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.r.walkover(c, id, b); }
}

@Controller('api')
export class MeController {
  constructor(private db: Db, private access: AccessService) {}

  private async routes(userId: string) {
    return this.db.query('SELECT * FROM route_user_tournaments($1)', [userId]);
  }

  /** Mes tournois (joueur, arbitre, organisateur invité), toutes organisations confondues. */
  @Get('me/tournaments') async tournaments(@Ctx() c: RequestContext) {
    const out: any[] = [];
    const byOrg = new Map<string, string[]>();
    for (const r of await this.routes(c.userId)) byOrg.set(r.org_id, [...(byOrg.get(r.org_id) ?? []), r.tournament_id]);
    for (const [orgId, ids] of byOrg) {
      out.push(...await this.db.orgTx(orgId, (tx) => many(tx,
        `SELECT t.id, t.slug, t.name, t.discipline, t.starts_at, t.venue_name, t.status, t.branding,
           (SELECT p.name FROM participant_members pm JOIN participants p ON p.id = pm.participant_id WHERE pm.tournament_id = t.id AND pm.user_id = $2 LIMIT 1) participant,
           (SELECT p.status FROM participant_members pm JOIN participants p ON p.id = pm.participant_id WHERE pm.tournament_id = t.id AND pm.user_id = $2 LIMIT 1) registration_status,
           (SELECT array_agg(role) FROM tournament_roles r WHERE r.tournament_id = t.id AND r.user_id = $2) roles
         FROM tournaments t WHERE t.id = ANY($1) ORDER BY t.starts_at DESC`, [ids, c.userId])));
    }
    return out;
  }

  /** Mes rencontres : prochaine rencontre, adversaire, terrain, horaire, scores à confirmer, rencontres à arbitrer. */
  @Get('me/matches') async matches(@Ctx() c: RequestContext) {
    const out: any[] = [];
    const byOrg = new Map<string, string[]>();
    for (const r of await this.routes(c.userId)) byOrg.set(r.org_id, [...(byOrg.get(r.org_id) ?? []), r.tournament_id]);
    for (const [orgId, ids] of byOrg) {
      await this.db.orgTx(orgId, async (tx) => {
        for (const tid of ids) {
          const a = await this.access.load(tx, c, tid, orgId);
          const s = await loadState(tx, tid);
          for (const m of s.matches) {
            const mine = [m.home_id, m.away_id].some((p) => p && a.participantIds.includes(p));
            const refereeing = m.referee_user_id === c.userId;
            if (!mine && !refereeing) continue;
            const pending = mine && m.status === 'awaiting_confirmation'
              ? (await many(tx, "SELECT id, submitter_role FROM score_submissions WHERE match_id = $1 AND status = 'pending'", [m.id]))[0] : undefined;
            const side = m.home_id && a.participantIds.includes(m.home_id) ? 'home' : 'away';
            out.push({ ...matchView(s, m), tournament: { id: s.t.id, name: s.t.name }, role: refereeing ? 'referee' : 'player', side: mine ? side : null,
              toConfirm: !!pending && pending.submitter_role !== side && ['home', 'away'].includes(pending.submitter_role), pendingSubmissionId: pending?.id ?? null });
          }
        }
      });
    }
    const rank = (m: any) => (m.toConfirm ? 0 : ['in_progress', 'called'].includes(m.status) ? 1 : ['scheduled', 'to_schedule', 'awaiting_confirmation', 'disputed', 'postponed'].includes(m.status) ? 2 : 3);
    out.sort((x, y) => rank(x) - rank(y) || String(x.scheduledAt ?? 'z').localeCompare(String(y.scheduledAt ?? 'z')));
    const next = out.find((m) => ['scheduled', 'called', 'in_progress', 'to_schedule'].includes(m.status) && m.role === 'player' && !m.home.placeholder && !m.away.placeholder);
    return { next: next ?? null, matches: out };
  }

  @Get('me/notifications') async notifications(@Ctx() c: RequestContext) {
    const orgs = await this.db.query('SELECT DISTINCT org_id FROM route_user_tournaments($1)', [c.userId]);
    const own = await this.db.query('SELECT org_id FROM org_members WHERE user_id = $1', [c.userId]);
    const all: any[] = [];
    for (const orgId of new Set([...orgs, ...own].map((o) => o.org_id))) {
      all.push(...await this.db.orgTx(orgId, (tx) => many(tx, 'SELECT id, type, title, body, link, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [c.userId])));
    }
    return all.sort((x, y) => +new Date(y.created_at) - +new Date(x.created_at)).slice(0, 100);
  }
  @Post('me/notifications/read') async read(@Ctx() c: RequestContext) {
    for (const r of await this.db.query('SELECT * FROM route_user_notifications($1)', [c.userId])) {
      await this.db.orgTx(r.org_id, (tx) => tx.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [c.userId]));
    }
    return { ok: true };
  }
}

@Controller('api')
export class JoinController {
  constructor(private p: ParticipantsService) {}
  /** Page d'atterrissage d'un QR Code (tournoi, participant, rencontre). */
  @Public() @Get('join/:token') resolve(@Param('token') token: string, @Req() req: any) { return this.p.resolveToken(token, req.ip); }
  @Post('join/register') register(@Ctx() c: RequestContext, @Body() b: unknown) { return this.p.selfRegister(c, b); }
  @Post('join/claim') claim(@Ctx() c: RequestContext, @Body() b: unknown) { return this.p.claim(c, b); }
  @Post('join/check-in') checkIn(@Ctx() c: RequestContext, @Body() b: unknown) { return this.p.checkInByToken(c, b); }

  /** Image QR (SVG) d'un lien de l'application uniquement : impression et téléchargement. */
  @Public() @Get('qr.svg') async svg(@Query('data') data: string, @Res() res: any) {
    if (!data || data.length > 500 || !(data.startsWith(config.appUrl + '/') || data.startsWith('/'))) throw badRequest('qr_data', 'Seuls les liens de l’application sont encodés');
    const svg = await QRCode.toString(data.startsWith('/') ? config.appUrl + data : data, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(svg);
  }
}

/** API de consultation publique (§10.4, §15) : tournois publiés et publics, sans aucune donnée de contact. */
@Controller('api/public')
export class PublicController {
  constructor(private access: AccessService, private db: Db, private live: LiveEvents) {}
  private async load(slug: string) {
    const r = await this.access.routeSlug(slug);
    if (!r.published || r.visibility !== 'public') throw notFound('Tournoi');
    return this.db.orgTx(r.orgId, async (tx) => tournamentView(await loadState(tx, r.id), { public: true }));
  }
  @Public() @Get('tournaments/:slug') get(@Param('slug') slug: string) { return this.load(slug); }
  @Public() @Get('tournaments/:slug/matches') async matches(@Param('slug') slug: string) { return (await this.load(slug)).matches; }
  @Public() @Get('tournaments/:slug/rankings') async rankings(@Param('slug') slug: string) {
    const v = await this.load(slug);
    return { groups: v.stages.filter((s) => s.groups).map((s) => ({ name: s.name, groups: s.groups })), final: v.ranking };
  }
  @Public() @Sse('tournaments/:slug/stream') async stream(@Param('slug') slug: string): Promise<Observable<any>> {
    const r = await this.access.routeSlug(slug);
    if (!r.published || r.visibility !== 'public') throw notFound('Tournoi');
    return merge(this.live.stream([r.id]), interval(25_000).pipe(map(() => ({ type: 'ping', data: {} }))));
  }
}
