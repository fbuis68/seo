/**
 * Participants (§3) : inscription par l'organisateur, import CSV, inscription autonome (lien, QR),
 * association sécurisée d'un compte à un joueur créé par l'organisateur, doubles et équipes,
 * liste d'attente, validation, présence, désistement, forfait et remplacement.
 */
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { config } from '../../config';
import { Access, AccessService } from '../../core/access';
import { RequestContext } from '../../core/context';
import { randomToken, sha256 } from '../../core/crypto';
import { parseCsv } from '../../core/csv';
import { Db, Tx, many, one } from '../../core/db';
import { AppError, badRequest, conflict, forbidden, notFound, paymentRequired } from '../../core/errors';
import { planOf } from '../../core/plans';
import { rateLimit } from '../../core/rate-limit';
import { audit, LiveEvents, Notifier } from '../../core/services';
import { ParticipantInput, ParticipantSchema } from './schemas';
import { ResultsService } from './results';
import { CLOSED, loadTournament, MatchRow, TournamentRow } from './state';

const membersFor = (mode: string) => (mode === 'single' ? [1, 1] : mode === 'double' ? [2, 2] : [1, 30]);
const displayName = (p: ParticipantInput, mode: string) =>
  p.name?.trim() || (mode === 'team' ? `Équipe ${p.members[0].lastName}` : p.members.map((m) => (mode === 'double' ? m.lastName : `${m.firstName} ${m.lastName}`)).join(' / '));

@Injectable()
export class ParticipantsService {
  constructor(private db: Db, private access: AccessService, private notifier: Notifier, private results: ResultsService) {}

  private validateMembers(t: TournamentRow, p: ParticipantInput) {
    const [min, max] = membersFor(t.mode);
    if (p.members.length < min || p.members.length > max) {
      throw badRequest('members_count', t.mode === 'double' ? 'Un double comporte deux joueurs.' : t.mode === 'single' ? 'Un seul joueur par inscription en individuel.' : `Équipe : ${min} à ${max} joueurs.`, 'members');
    }
    const reg = t.registration ?? {};
    p.members.forEach((m, i) => {
      if (reg.collectEmail === 'required' && !m.email && i === 0) throw badRequest('email_required', 'Email obligatoire pour ce tournoi', `members.${i}.email`);
      if (reg.collectPhone === 'required' && !m.phone && i === 0) throw badRequest('phone_required', 'Téléphone obligatoire pour ce tournoi', `members.${i}.phone`);
    });
    if (p.category && reg.categories?.length && !reg.categories.includes(p.category)) throw badRequest('category_unknown', 'Catégorie inconnue', 'category');
  }

  /** Statut à l'inscription : confirmé, en attente de validation, ou liste d'attente si complet. */
  private async admissionStatus(tx: Tx, t: TournamentRow, requested?: string, selfService = false): Promise<{ status: string; waitlistPosition: number | null }> {
    const [{ n, w }] = await many(tx, `SELECT count(*) FILTER (WHERE status = 'confirmed')::int n, coalesce(max(waitlist_position), 0)::int w FROM participants WHERE tournament_id = $1`, [t.id]);
    const wantsConfirmed = requested ? requested === 'confirmed' : !(selfService && t.registration?.requireApproval);
    if (requested === 'waitlist' || (wantsConfirmed && n >= t.max_participants)) return { status: 'waitlist', waitlistPosition: w + 1 };
    if (!wantsConfirmed) return { status: requested ?? 'pending', waitlistPosition: null };
    return { status: 'confirmed', waitlistPosition: null };
  }

  async insert(tx: Tx, a: Access, t: TournamentRow, p: ParticipantInput, actorId: string | null, source: 'organizer' | 'self' | 'import' | 'qr', selfUserId?: string) {
    this.validateMembers(t, p);
    const adm = await this.admissionStatus(tx, t, p.status, source === 'self' || source === 'qr');
    const row = (await one(tx,
      `INSERT INTO participants(org_id, tournament_id, name, club, category, rating, seed, status, waitlist_position, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [a.orgId, t.id, displayName(p, t.mode), p.club ?? null, p.category ?? null, p.rating ?? null, p.seed ?? null, adm.status, adm.waitlistPosition, source, actorId]))!;
    const members = [];
    for (let i = 0; i < p.members.length; i++) {
      const m = p.members[i];
      members.push((await one(tx,
        `INSERT INTO participant_members(org_id, participant_id, tournament_id, position, first_name, last_name, email, phone, user_id, is_captain)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, first_name, last_name, user_id`,
        [a.orgId, row.id, t.id, i + 1, m.firstName, m.lastName, m.email ?? null, m.phone ?? null, i === 0 && selfUserId ? selfUserId : null, !!m.isCaptain]))!);
    }
    await audit(tx, { orgId: a.orgId, tournamentId: t.id, actorId, entity: 'participant', entityId: row.id, action: 'registered', after: { name: row.name, status: row.status, source } });
    await LiveEvents.emit(tx, t.id, 'participants');
    return { ...row, members };
  }

  private async assertCapacityPlan(tx: Tx, t: TournamentRow) {
    const org = await one(tx, 'SELECT plan FROM organizations WHERE id = $1', [t.org_id]);
    const [{ n }] = await many(tx, "SELECT count(*)::int n FROM participants WHERE tournament_id = $1 AND status NOT IN ('refused','withdrawn')", [t.id]);
    const limit = planOf(org?.plan).maxParticipants;
    if (n >= limit + Math.max(10, Math.ceil(limit / 4))) throw paymentRequired('participants_quota', `Votre offre est limitée à ${limit} participants par tournoi (liste d’attente comprise).`);
  }

  async add(ctx: RequestContext, tid: string, body: unknown) {
    const p = ParticipantSchema.parse(body);
    return this.access.asOrganizer(ctx, tid, async (tx, a) => {
      const t = await loadTournament(tx, tid, true);
      await this.assertCapacityPlan(tx, t);
      const row = await this.insert(tx, a, t, p, ctx.userId, 'organizer');
      if (t.generated_at && row.status === 'confirmed') row.warning = 'Rencontres déjà générées : ce participant n’y figure pas (remplacement ou nouvelle génération).';
      return row;
    });
  }

  async list(ctx: RequestContext, tid: string) {
    return this.access.asOrganizer(ctx, tid, async (tx) => {
      const ps = await many(tx, `SELECT * FROM participants WHERE tournament_id = $1 ORDER BY
        CASE status WHEN 'confirmed' THEN 0 WHEN 'pending' THEN 1 WHEN 'waitlist' THEN 2 ELSE 3 END, seed NULLS LAST, rating DESC NULLS LAST, created_at`, [tid]);
      const ms = await many(tx, `SELECT id, participant_id, position, first_name, last_name, email, phone, user_id IS NOT NULL linked, is_captain,
        claim_requested_by IS NOT NULL claim_pending FROM participant_members WHERE tournament_id = $1 ORDER BY position`, [tid]);
      return ps.map((p) => ({ ...p, members: ms.filter((m) => m.participant_id === p.id) }));
    });
  }

  async update(ctx: RequestContext, participantId: string, body: unknown) {
    const b = ParticipantSchema.partial().extend({ checkedIn: z.boolean().optional() }).parse(body);
    const r = await this.access.routeParticipant(participantId);
    return this.access.asOrganizer(ctx, r.tournamentId, async (tx, a) => {
      const t = await loadTournament(tx, r.tournamentId);
      const before = await one(tx, 'SELECT * FROM participants WHERE id = $1 FOR UPDATE', [participantId]);
      if (b.members) {
        this.validateMembers(t, { ...b, members: b.members } as ParticipantInput);
        const existing = await many(tx, 'SELECT id, position FROM participant_members WHERE participant_id = $1 ORDER BY position', [participantId]);
        for (let i = 0; i < b.members.length; i++) {
          const m = b.members[i];
          if (existing[i]) await tx.query('UPDATE participant_members SET first_name = $2, last_name = $3, email = $4, phone = $5, is_captain = $6 WHERE id = $1', [existing[i].id, m.firstName, m.lastName, m.email ?? null, m.phone ?? null, !!m.isCaptain]);
          else await tx.query('INSERT INTO participant_members(org_id, participant_id, tournament_id, position, first_name, last_name, email, phone, is_captain) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [a.orgId, participantId, t.id, i + 1, m.firstName, m.lastName, m.email ?? null, m.phone ?? null, !!m.isCaptain]);
        }
        for (const extra of existing.slice(b.members.length)) await tx.query('DELETE FROM participant_members WHERE id = $1 AND user_id IS NULL', [extra.id]);
      }
      const name = b.name !== undefined || b.members ? displayName({ name: b.name ?? undefined, members: b.members ?? (await many(tx, 'SELECT first_name "firstName", last_name "lastName" FROM participant_members WHERE participant_id = $1 ORDER BY position', [participantId])) } as any, t.mode) : before.name;
      await tx.query(`UPDATE participants SET name = $2, club = coalesce($3, club), category = coalesce($4, category), rating = CASE WHEN $8 THEN $5 ELSE rating END,
          seed = CASE WHEN $9 THEN $6 ELSE seed END, checked_in_at = CASE WHEN $7::boolean IS NULL THEN checked_in_at WHEN $7 THEN coalesce(checked_in_at, now()) ELSE NULL END WHERE id = $1`,
        [participantId, name, b.club ?? null, b.category ?? null, b.rating ?? null, b.seed ?? null, b.checkedIn ?? null, b.rating !== undefined, b.seed !== undefined]);
      await audit(tx, { orgId: a.orgId, tournamentId: t.id, actorId: ctx.userId, entity: 'participant', entityId: participantId, action: 'updated', before: { name: before.name, rating: before.rating, seed: before.seed }, after: b });
      await LiveEvents.emit(tx, t.id, 'participants');
      return one(tx, 'SELECT * FROM participants WHERE id = $1', [participantId]);
    });
  }

  /**
   * Changement de statut administratif : validation, refus, liste d'attente, désistement, forfait.
   * Le forfait d'un participant engagé déclare forfait toutes ses rencontres restantes (classement cohérent, CA13).
   */
  async setStatus(ctx: RequestContext, participantId: string, body: unknown) {
    const b = z.object({ status: z.enum(['confirmed', 'refused', 'waitlist', 'withdrawn', 'forfeit']), reason: z.string().trim().max(500).optional() }).parse(body);
    const r = await this.access.routeParticipant(participantId);
    return this.access.asOrganizer(ctx, r.tournamentId, async (tx, a) => {
      const t = await loadTournament(tx, r.tournamentId, true);
      const p = await one(tx, 'SELECT * FROM participants WHERE id = $1 FOR UPDATE', [participantId]);
      if (!p) throw notFound('Participant');
      const engaged = !!(await one(tx, 'SELECT 1 FROM matches WHERE home_id = $1 OR away_id = $1 LIMIT 1', [participantId]));
      if (engaged && ['refused', 'waitlist'].includes(b.status)) throw conflict('participant_engaged', 'Participant déjà engagé dans des rencontres : utilisez forfait ou remplacement.');
      if (engaged && b.status === 'withdrawn') b.status = 'forfeit';
      if (b.status === 'confirmed' && p.status !== 'confirmed') {
        const [{ n }] = await many(tx, "SELECT count(*)::int n FROM participants WHERE tournament_id = $1 AND status = 'confirmed'", [t.id]);
        if (n >= t.max_participants) throw conflict('tournament_full', `Tournoi complet (${t.max_participants}) : augmentez la capacité ou laissez en liste d’attente.`);
      }
      await tx.query(`UPDATE participants SET status = $2, waitlist_position = CASE WHEN $2 = 'waitlist' THEN coalesce(waitlist_position,
          (SELECT coalesce(max(waitlist_position),0)+1 FROM participants WHERE tournament_id = $3)) ELSE NULL END WHERE id = $1`, [participantId, b.status, t.id]);
      await audit(tx, { orgId: a.orgId, tournamentId: t.id, actorId: ctx.userId, entity: 'participant', entityId: participantId, action: `status_${b.status}`, before: { status: p.status }, after: { status: b.status }, reason: b.reason });
      const users = (await many(tx, 'SELECT user_id FROM participant_members WHERE participant_id = $1 AND user_id IS NOT NULL', [participantId])).map((x) => x.user_id);
      if (b.status === 'confirmed') await this.notifier.notify(tx, { orgId: a.orgId, tournamentId: t.id, userIds: users, type: 'registration_confirmed', title: `Inscription confirmée : ${t.name}`, link: `/t/${t.id}` });
      let walkovers = 0;
      if (b.status === 'forfeit') {
        const open = await many<MatchRow>(tx, `SELECT * FROM matches WHERE (home_id = $1 OR away_id = $1) AND status NOT IN ('completed','walkover','bye','cancelled') AND home_id IS NOT NULL AND away_id IS NOT NULL ORDER BY round`, [participantId]);
        for (const m of open) {
          await this.results.walkover(ctx, m.id, { loser: m.home_id === participantId ? 'home' : 'away', reason: b.reason ?? 'Forfait du participant' }, { tx, a });
          walkovers++;
        }
      }
      // Place libérée avant le tirage : le premier de la liste d'attente est promu.
      let promoted: string | null = null;
      if (p.status === 'confirmed' && ['withdrawn', 'refused', 'waitlist'].includes(b.status) && !t.generated_at) {
        const next = await one(tx, "SELECT id FROM participants WHERE tournament_id = $1 AND status = 'waitlist' ORDER BY waitlist_position LIMIT 1 FOR UPDATE", [t.id]);
        if (next) {
          await tx.query("UPDATE participants SET status = 'confirmed', waitlist_position = NULL WHERE id = $1", [next.id]);
          promoted = next.id;
          const u = (await many(tx, 'SELECT user_id FROM participant_members WHERE participant_id = $1 AND user_id IS NOT NULL', [next.id])).map((x) => x.user_id);
          await this.notifier.notify(tx, { orgId: a.orgId, tournamentId: t.id, userIds: u, type: 'registration_confirmed', title: `Une place s’est libérée : inscription confirmée à ${t.name}`, link: `/t/${t.id}` });
        }
      }
      await LiveEvents.emit(tx, t.id, 'participants');
      return { id: participantId, status: b.status, walkovers, promoted };
    });
  }

  /**
   * Remplacement : le remplaçant reprend la place du participant dans la poule et les rencontres
   * (y compris les résultats déjà acquis, attribués à la place), l'ancien participant est désisté.
   */
  async replace(ctx: RequestContext, participantId: string, body: unknown) {
    const b = z.object({ replacementId: z.string().uuid().optional(), participant: ParticipantSchema.optional(), reason: z.string().trim().min(2).max(500) }).parse(body);
    const r = await this.access.routeParticipant(participantId);
    return this.access.asOrganizer(ctx, r.tournamentId, async (tx, a) => {
      const t = await loadTournament(tx, r.tournamentId, true);
      const old = await one(tx, 'SELECT * FROM participants WHERE id = $1 FOR UPDATE', [participantId]);
      let newId = b.replacementId;
      if (!newId) {
        if (!b.participant) throw badRequest('replacement_required', 'Remplaçant requis (existant ou nouveau)');
        newId = (await this.insert(tx, a, t, { ...b.participant, status: 'waitlist' }, ctx.userId, 'organizer')).id;
      }
      const rep = await one(tx, 'SELECT * FROM participants WHERE id = $1 AND tournament_id = $2 FOR UPDATE', [newId, t.id]);
      if (!rep || rep.id === old.id) throw badRequest('replacement_invalid', 'Remplaçant invalide');
      if (await one(tx, 'SELECT 1 FROM matches WHERE home_id = $1 OR away_id = $1 LIMIT 1', [rep.id])) throw conflict('replacement_engaged', 'Le remplaçant est déjà engagé dans des rencontres.');
      await tx.query("UPDATE participants SET status = 'confirmed', waitlist_position = NULL, seed = $2 WHERE id = $1", [rep.id, old.seed]);
      await tx.query("UPDATE participants SET status = 'withdrawn', replaced_by = $2 WHERE id = $1", [old.id, rep.id]);
      for (const col of ['home_id', 'away_id', 'winner_id']) await tx.query(`UPDATE matches SET ${col} = $2, version = version + 1 WHERE ${col} = $1`, [old.id, rep.id]);
      await tx.query('UPDATE group_members SET participant_id = $2 WHERE participant_id = $1', [old.id, rep.id]);
      await tx.query(`UPDATE score_submissions SET status = 'superseded' WHERE status IN ('pending','disputed') AND match_id IN (SELECT id FROM matches WHERE home_id = $1 OR away_id = $1)`, [rep.id]);
      await tx.query(`UPDATE matches SET status = CASE WHEN scheduled_at IS NULL THEN 'to_schedule' ELSE 'scheduled' END WHERE (home_id = $1 OR away_id = $1) AND status IN ('awaiting_confirmation','disputed')`, [rep.id]);
      await audit(tx, { orgId: a.orgId, tournamentId: t.id, actorId: ctx.userId, entity: 'participant', entityId: old.id, action: 'replaced', before: { id: old.id, name: old.name }, after: { id: rep.id, name: rep.name }, reason: b.reason });
      await LiveEvents.emit(tx, t.id, 'participants');
      return { replaced: old.id, by: rep.id };
    });
  }

  async remove(ctx: RequestContext, participantId: string) {
    const r = await this.access.routeParticipant(participantId);
    return this.access.asOrganizer(ctx, r.tournamentId, async (tx, a) => {
      if (await one(tx, 'SELECT 1 FROM matches WHERE home_id = $1 OR away_id = $1 LIMIT 1', [participantId])) throw conflict('participant_engaged', 'Participant engagé dans des rencontres : utilisez forfait ou remplacement.');
      const p = await one(tx, 'DELETE FROM participants WHERE id = $1 RETURNING name', [participantId]);
      await audit(tx, { orgId: a.orgId, tournamentId: r.tournamentId, actorId: ctx.userId, entity: 'participant', entityId: participantId, action: 'deleted', before: p });
      await LiveEvents.emit(tx, r.tournamentId, 'participants');
      return { deleted: true };
    });
  }

  /** Import CSV/Excel (export CSV) : colonnes reconnues par leur en-tête, rapport ligne à ligne, simulation possible. */
  async importCsv(ctx: RequestContext, tid: string, body: unknown) {
    const b = z.object({ csv: z.string().min(1).max(2_000_000), dryRun: z.boolean().default(false) }).parse(body);
    const rows = parseCsv(b.csv);
    if (rows.length < 2) throw badRequest('csv_empty', 'Le fichier doit contenir une ligne d’en-tête et au moins un participant');
    const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const ALIASES: Record<string, string[]> = {
      lastName: ['nom', 'nom1', 'lastname', 'name'], firstName: ['prenom', 'prenom1', 'firstname'], email: ['email', 'mail', 'email1', 'courriel'],
      phone: ['telephone', 'tel', 'phone', 'mobile', 'telephone1'], club: ['club', 'association'], rating: ['niveau', 'classement', 'rating', 'points', 'level'],
      category: ['categorie', 'category'], name: ['equipe', 'pseudo', 'pseudonyme', 'team', 'nomequipe'], seed: ['tetedeserie', 'seed', 'tds'],
      lastName2: ['nom2', 'nompartenaire', 'partenairenom'], firstName2: ['prenom2', 'prenompartenaire', 'partenaireprenom'], email2: ['email2', 'emailpartenaire'], phone2: ['telephone2', 'tel2', 'telephonepartenaire'],
    };
    const header = rows[0].map(norm);
    const col: Record<string, number> = {};
    for (const [k, al] of Object.entries(ALIASES)) { const i = header.findIndex((h) => al.includes(h)); if (i >= 0) col[k] = i; }
    if (col.lastName === undefined) throw badRequest('csv_columns', 'Colonne « Nom » introuvable. Colonnes attendues : Nom, Prénom, Email, Téléphone, Club, Niveau, Catégorie, Équipe (+ Nom2, Prénom2 pour le partenaire de double).');
    return this.access.asOrganizer(ctx, tid, async (tx, a) => {
      const t = await loadTournament(tx, tid, true);
      const results: { line: number; status: 'created' | 'error' | 'duplicate'; name?: string; message?: string; participantStatus?: string }[] = [];
      const seen = new Set((await many(tx, 'SELECT lower(first_name || last_name || coalesce(email, \'\')) k FROM participant_members WHERE tournament_id = $1', [tid])).map((x) => x.k));
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i], get = (k: string) => (col[k] !== undefined ? (r[col[k]] ?? '').trim() : '');
        const members = [{ firstName: get('firstName') || '-', lastName: get('lastName'), email: get('email') || undefined, phone: get('phone') || undefined }];
        if (t.mode === 'double' || get('lastName2')) members.push({ firstName: get('firstName2') || '-', lastName: get('lastName2'), email: get('email2') || undefined, phone: get('phone2') || undefined });
        const rating = get('rating') ? Number(get('rating').replace(',', '.')) : undefined;
        const input = { name: get('name') || undefined, club: get('club') || undefined, category: get('category') || undefined, rating: Number.isFinite(rating) ? rating : undefined, seed: get('seed') ? Number(get('seed')) : undefined, members };
        const key = (members[0].firstName + members[0].lastName + (members[0].email ?? '')).toLowerCase();
        if (seen.has(key)) { results.push({ line: i + 1, status: 'duplicate', name: `${members[0].firstName} ${members[0].lastName}`, message: 'Déjà inscrit' }); continue; }
        await tx.query('SAVEPOINT imp');
        try {
          const p = ParticipantSchema.parse(input);
          this.validateMembers(t, p);
          if (!b.dryRun) {
            const row = await this.insert(tx, a, t, p, ctx.userId, 'import');
            results.push({ line: i + 1, status: 'created', name: row.name, participantStatus: row.status });
          } else results.push({ line: i + 1, status: 'created', name: displayName(p, t.mode) });
          await tx.query('RELEASE SAVEPOINT imp');
          seen.add(key);
        } catch (e: any) {
          await tx.query('ROLLBACK TO SAVEPOINT imp').catch(() => undefined);
          const msg = e?.issues?.[0] ? `${e.issues[0].path.join('.')} : ${e.issues[0].message}` : e.message;
          results.push({ line: i + 1, status: 'error', message: msg });
        }
      }
      return { dryRun: b.dryRun, created: results.filter((x) => x.status === 'created').length, errors: results.filter((x) => x.status === 'error').length, duplicates: results.filter((x) => x.status === 'duplicate').length, results };
    });
  }

  /** Joueurs déjà connus du club (tournois précédents) : réutilisation sans ressaisie. */
  async knownPlayers(ctx: RequestContext, orgId: string, q?: string) {
    const [m] = await this.db.query('SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, ctx.userId]);
    if (!m && !ctx.isPlatformAdmin) throw notFound('Organisation');
    return this.db.orgTx(orgId, (tx) => many(tx,
      `SELECT DISTINCT ON (lower(pm.first_name), lower(pm.last_name), coalesce(lower(pm.email), ''))
              pm.first_name "firstName", pm.last_name "lastName", pm.email, pm.phone, p.club, p.rating
         FROM participant_members pm JOIN participants p ON p.id = pm.participant_id
        WHERE ($1::text IS NULL OR (pm.first_name || ' ' || pm.last_name || ' ' || coalesce(pm.email, '')) ILIKE '%' || $1 || '%')
        ORDER BY lower(pm.first_name), lower(pm.last_name), coalesce(lower(pm.email), ''), pm.created_at DESC LIMIT 50`, [q?.trim() || null]));
  }

  // ───────────── QR Codes et jetons ─────────────

  static async createToken(tx: Tx, a: { orgId: string; tournamentId: string }, kind: 'tournament' | 'participant' | 'match', targetId: string | null, actorId: string | null, days?: number | null) {
    const token = randomToken();
    await tx.query(
      `INSERT INTO qr_tokens(org_id, tournament_id, kind, target_id, token_hash, token_hint, token_plain, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(days => $8::int) END, $9)`,
      [a.orgId, a.tournamentId, kind, targetId, sha256(token), token.slice(-4), kind === 'participant' ? null : token, days ?? null, actorId]);
    return token;
  }

  /** Jeton d'inscription / consultation du tournoi (un seul actif ; régénérable = révocation du précédent). */
  async tournamentToken(tx: Tx, a: Access, actorId: string, rotate = false) {
    if (rotate) await tx.query("UPDATE qr_tokens SET revoked_at = now() WHERE tournament_id = $1 AND kind = 'tournament' AND revoked_at IS NULL", [a.tournamentId]);
    const cur = await one(tx, "SELECT token_plain FROM qr_tokens WHERE tournament_id = $1 AND kind = 'tournament' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC LIMIT 1", [a.tournamentId]);
    return cur?.token_plain ?? ParticipantsService.createToken(tx, a, 'tournament', null, actorId, null);
  }

  /** Invitation individuelle : jeton à usage unique, expirant, qui associe un compte à un membre (QR participant). */
  async inviteMember(ctx: RequestContext, memberId: string, body: unknown) {
    const b = z.object({ days: z.number().int().min(1).max(365).optional() }).parse(body ?? {});
    if (!/^[0-9a-f-]{36}$/i.test(memberId)) throw notFound('Joueur');
    const [route] = await this.db.query('SELECT * FROM route_member($1)', [memberId]);
    if (!route) throw notFound('Joueur');
    return this.access.asOrganizer(ctx, route.tournament_id, async (tx, a) => {
      const m = await one(tx, 'SELECT * FROM participant_members WHERE id = $1', [memberId]);
      if (!m) throw notFound('Joueur');
      if (m.user_id) throw conflict('already_linked', 'Ce joueur est déjà associé à un compte.');
      await tx.query("UPDATE qr_tokens SET revoked_at = now() WHERE kind = 'participant' AND target_id = $1 AND revoked_at IS NULL", [memberId]);
      const token = await ParticipantsService.createToken(tx, a, 'participant', memberId, ctx.userId, b.days ?? config.participantTokenDays);
      await audit(tx, { orgId: a.orgId, tournamentId: a.tournamentId, actorId: ctx.userId, entity: 'participant_member', entityId: memberId, action: 'invite_created' });
      return { token, url: `${config.appUrl}/join/${token}`, expiresInDays: b.days ?? config.participantTokenDays };
    });
  }
  async revokeToken(ctx: RequestContext, tid: string, tokenId: string) {
    return this.access.asOrganizer(ctx, tid, async (tx, a) => {
      const r = await one(tx, 'UPDATE qr_tokens SET revoked_at = now() WHERE id = $1 AND tournament_id = $2 AND revoked_at IS NULL RETURNING id, kind', [tokenId, tid]);
      if (!r) throw notFound('Jeton');
      await audit(tx, { orgId: a.orgId, tournamentId: tid, actorId: ctx.userId, entity: 'qr_token', entityId: tokenId, action: 'revoked' });
      return { revoked: true };
    });
  }

  async listTokens(ctx: RequestContext, tid: string) {
    return this.access.asOrganizer(ctx, tid, (tx) => many(tx,
      `SELECT q.id, q.kind, q.target_id, q.token_hint, q.expires_at, q.revoked_at, q.used_at, q.created_at, pm.first_name, pm.last_name
         FROM qr_tokens q LEFT JOIN participant_members pm ON pm.id = q.target_id WHERE q.tournament_id = $1 ORDER BY q.created_at DESC`, [tid]));
  }

  /** Résolution d'un jeton scanné (page d'atterrissage QR) : n'expose que le strict nécessaire. */
  async resolveToken(token: string, ip?: string) {
    await rateLimit(this.db, `qr:${ip}`, 120, 600);
    const [r] = await this.db.query('SELECT * FROM route_qr($1)', [sha256(token)]);
    if (!r) throw notFound('Lien');
    return this.db.orgTx(r.org_id, async (tx) => {
      const q = await one(tx, 'SELECT * FROM qr_tokens WHERE id = $1', [r.id]);
      const t = await loadTournament(tx, r.tournament_id);
      const invalid = q.revoked_at ? 'revoked' : q.expires_at && new Date(q.expires_at) < new Date() ? 'expired' : q.used_at ? 'used' : null;
      const base = { kind: q.kind, invalid, tournament: { id: t.id, slug: t.slug, name: t.name, mode: t.mode, discipline: t.discipline, startsAt: t.starts_at, venueName: t.venue_name, registrationOpen: this.registrationOpen(t), branding: t.branding, categories: t.registration?.categories ?? [] } };
      if (q.kind === 'participant') {
        const m = await one(tx, 'SELECT pm.first_name, pm.user_id IS NOT NULL linked, p.name FROM participant_members pm JOIN participants p ON p.id = pm.participant_id WHERE pm.id = $1', [q.target_id]);
        return { ...base, member: m ? { firstName: m.first_name, participant: m.name, linked: m.linked } : null };
      }
      if (q.kind === 'match') return { ...base, matchId: q.target_id };
      return base;
    });
  }

  private registrationOpen(t: TournamentRow) {
    const reg = t.registration ?? {};
    if (!t.published_at || reg.open === false || t.generated_at || ['finished', 'archived'].includes(t.status)) return false;
    return !(reg.closesAt && new Date(reg.closesAt) < new Date());
  }

  /** Association sécurisée d'un compte à un joueur créé par l'organisateur, via son jeton individuel (usage unique). */
  async claim(ctx: RequestContext, body: unknown) {
    const b = z.object({ token: z.string().min(20).max(100) }).parse(body);
    await rateLimit(this.db, `claim:${ctx.userId}`, 20, 3600);
    const [r] = await this.db.query('SELECT * FROM route_qr($1)', [sha256(b.token)]);
    if (!r) throw notFound('Invitation');
    return this.db.orgTx(r.org_id, async (tx) => {
      const q = await one(tx, 'SELECT * FROM qr_tokens WHERE id = $1 FOR UPDATE', [r.id]);
      if (q.kind !== 'participant') throw badRequest('wrong_token', 'Ce QR Code n’est pas une invitation individuelle');
      if (q.revoked_at) throw new AppError(410, 'token_revoked', 'Invitation révoquée : demandez un nouveau QR Code à l’organisateur.');
      if (q.expires_at && new Date(q.expires_at) < new Date()) throw new AppError(410, 'token_expired', 'Invitation expirée : demandez un nouveau QR Code à l’organisateur.');
      if (q.used_at) throw new AppError(410, 'token_used', 'Invitation déjà utilisée.');
      const m = await one(tx, 'SELECT * FROM participant_members WHERE id = $1 FOR UPDATE', [q.target_id]);
      if (!m || m.user_id) throw conflict('already_linked', 'Ce joueur est déjà associé à un compte.');
      if (await one(tx, 'SELECT 1 FROM participant_members WHERE tournament_id = $1 AND user_id = $2', [q.tournament_id, ctx.userId])) throw conflict('already_registered', 'Votre compte est déjà associé à un joueur de ce tournoi.');
      await tx.query('UPDATE participant_members SET user_id = $2, email = coalesce(email, $3), claim_requested_by = NULL WHERE id = $1', [m.id, ctx.userId, ctx.email]);
      await tx.query('UPDATE qr_tokens SET used_at = now(), uses = uses + 1 WHERE id = $1', [q.id]);
      await audit(tx, { orgId: r.org_id, tournamentId: q.tournament_id, actorId: ctx.userId, entity: 'participant_member', entityId: m.id, action: 'claimed_by_token' });
      await LiveEvents.emit(tx, q.tournament_id, 'participants');
      return { tournamentId: q.tournament_id, participantId: m.participant_id };
    });
  }

  /** Sans invitation : demande d'association à un joueur existant, validée par l'organisateur (anti-usurpation). */
  async requestClaim(ctx: RequestContext, tid: string, body: unknown) {
    const b = z.object({ memberId: z.string().uuid() }).parse(body);
    return this.access.withTournament(ctx, tid, async (tx, a) => {
      const m = await one(tx, 'SELECT * FROM participant_members WHERE id = $1 AND tournament_id = $2 FOR UPDATE', [b.memberId, tid]);
      if (!m) throw notFound('Joueur');
      if (m.user_id) throw conflict('already_linked', 'Ce joueur est déjà associé à un compte.');
      if (a.participantIds.length) throw conflict('already_registered', 'Votre compte est déjà associé à un joueur de ce tournoi.');
      await tx.query('UPDATE participant_members SET claim_requested_by = $2, claim_requested_at = now() WHERE id = $1', [m.id, ctx.userId]);
      const orgs = await many(tx, "SELECT user_id FROM org_members WHERE org_id = $1 AND role IN ('owner','manager') UNION SELECT user_id FROM tournament_roles WHERE tournament_id = $2 AND role = 'organizer' UNION SELECT created_by FROM tournaments WHERE id = $2", [a.orgId, tid]);
      await this.notifier.notify(tx, { orgId: a.orgId, tournamentId: tid, userIds: orgs.map((x) => x.user_id), type: 'claim_request', title: 'Demande d’association de profil', body: `${ctx.firstName} ${ctx.lastName} (${ctx.email}) demande à être associé à ${m.first_name} ${m.last_name}.`, link: `/t/${tid}` });
      return { requested: true };
    });
  }

  async decideClaim(ctx: RequestContext, memberId: string, body: unknown) {
    const b = z.object({ tournamentId: z.string().uuid(), approve: z.boolean() }).parse(body);
    return this.access.asOrganizer(ctx, b.tournamentId, async (tx, a) => {
      const m = await one(tx, 'SELECT * FROM participant_members WHERE id = $1 AND tournament_id = $2 FOR UPDATE', [memberId, b.tournamentId]);
      if (!m?.claim_requested_by) throw notFound('Demande');
      if (b.approve) {
        if (await one(tx, 'SELECT 1 FROM participant_members WHERE tournament_id = $1 AND user_id = $2', [b.tournamentId, m.claim_requested_by])) throw conflict('already_registered', 'Ce compte est déjà associé à un joueur du tournoi.');
        await tx.query('UPDATE participant_members SET user_id = claim_requested_by, claim_requested_by = NULL WHERE id = $1', [memberId]);
      } else await tx.query('UPDATE participant_members SET claim_requested_by = NULL WHERE id = $1', [memberId]);
      await audit(tx, { orgId: a.orgId, tournamentId: b.tournamentId, actorId: ctx.userId, entity: 'participant_member', entityId: memberId, action: b.approve ? 'claim_approved' : 'claim_refused', after: { user: m.claim_requested_by } });
      return { approved: b.approve };
    });
  }

  /** Inscription autonome (lien public ou QR tournoi) : le compte connecté devient le 1er membre et capitaine. */
  async selfRegister(ctx: RequestContext, body: unknown) {
    const b = z.object({ token: z.string().max(100).optional(), slug: z.string().max(120).optional(), participant: ParticipantSchema }).parse(body);
    await rateLimit(this.db, `register:${ctx.userId}`, 20, 3600);
    let route: { org_id: string; tournament_id: string } | undefined;
    if (b.token) {
      const [r] = await this.db.query('SELECT * FROM route_qr($1)', [sha256(b.token)]);
      if (r) route = { org_id: r.org_id, tournament_id: r.tournament_id };
    } else if (b.slug) {
      const r = await this.access.routeSlug(b.slug);
      if (r.visibility !== 'public') throw forbidden('private_tournament', 'Tournoi privé : inscription par QR Code ou lien d’invitation uniquement.');
      route = { org_id: r.orgId, tournament_id: r.id };
    }
    if (!route) throw notFound('Tournoi');
    return this.db.orgTx(route.org_id, async (tx) => {
      if (b.token) {
        const q = await one(tx, 'SELECT * FROM qr_tokens WHERE token_hash = $1', [sha256(b.token)]);
        if (q.kind !== 'tournament' || q.revoked_at || (q.expires_at && new Date(q.expires_at) < new Date())) throw new AppError(410, 'token_invalid', 'Lien d’inscription invalide ou expiré.');
      }
      const t = await loadTournament(tx, route!.tournament_id, true);
      if (!this.registrationOpen(t)) throw conflict('registration_closed', 'Les inscriptions à ce tournoi sont closes.');
      const a = await this.access.load(tx, ctx, t.id, route!.org_id);
      if (a.participantIds.length) throw conflict('already_registered', 'Vous êtes déjà inscrit à ce tournoi.');
      await this.assertCapacityPlan(tx, t);
      const p = b.participant;
      // Le 1er membre est l'utilisateur connecté (identité du compte), capitaine de l'équipe.
      p.members[0] = { ...p.members[0], firstName: ctx.firstName, lastName: ctx.lastName, email: ctx.email, isCaptain: t.mode !== 'single' };
      const row = await this.insert(tx, a, t, { ...p, status: undefined }, ctx.userId, b.token ? 'qr' : 'self', ctx.userId);
      // Partenaire(s) : invitation individuelle à partager pour rejoindre l'équipe.
      const invites = [];
      for (const m of row.members.slice(1)) {
        const token = await ParticipantsService.createToken(tx, a, 'participant', m.id, ctx.userId, config.participantTokenDays);
        invites.push({ memberId: m.id, name: `${m.first_name} ${m.last_name}`, url: `${config.appUrl}/join/${token}` });
      }
      const type = row.status === 'confirmed' ? 'registration_confirmed' : row.status === 'waitlist' ? 'registration_waitlist' : 'registration_pending';
      const title = row.status === 'confirmed' ? `Inscription confirmée : ${t.name}` : row.status === 'waitlist' ? `${t.name} : vous êtes en liste d’attente (position ${row.waitlist_position})` : `${t.name} : inscription en attente de validation`;
      await this.notifier.notify(tx, { orgId: a.orgId, tournamentId: t.id, userIds: [ctx.userId], type: type as any, title, link: `/t/${t.id}` });
      return { tournamentId: t.id, participantId: row.id, status: row.status, waitlistPosition: row.waitlist_position, invites };
    });
  }

  /** Présence sur site : scan du QR participant par l'organisateur, ou pointage depuis la liste. */
  async checkInByToken(ctx: RequestContext, body: unknown) {
    const b = z.object({ token: z.string().min(20).max(100) }).parse(body);
    const [r] = await this.db.query('SELECT * FROM route_qr($1)', [sha256(b.token)]);
    if (!r) throw notFound('QR Code');
    return this.access.asOrganizer(ctx, r.tournament_id, async (tx, a) => {
      const q = await one(tx, 'SELECT * FROM qr_tokens WHERE id = $1', [r.id]);
      if (q.kind !== 'participant' || q.revoked_at) throw badRequest('wrong_token', 'QR Code participant invalide');
      const m = await one(tx, 'SELECT participant_id FROM participant_members WHERE id = $1', [q.target_id]);
      const p = await one(tx, 'UPDATE participants SET checked_in_at = coalesce(checked_in_at, now()) WHERE id = $1 RETURNING id, name, checked_in_at', [m.participant_id]);
      await audit(tx, { orgId: a.orgId, tournamentId: r.tournament_id, actorId: ctx.userId, entity: 'participant', entityId: p.id, action: 'checked_in' });
      await LiveEvents.emit(tx, r.tournament_id, 'participants');
      return p;
    });
  }

  /** Une rencontre déjà close ne peut pas être affectée par un changement d'inscription. */
  static closed = (m: MatchRow) => CLOSED.has(m.status);
}
