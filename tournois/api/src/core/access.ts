import { Injectable } from '@nestjs/common';
import { RequestContext } from './context';
import { Db, many, one, Tx } from './db';
import { forbidden, notFound } from './errors';

export interface TournamentRoute { id: string; orgId: string; visibility: 'public' | 'private'; published: boolean; }

export interface Access {
  tournamentId: string;
  orgId: string;
  organizer: boolean;
  referee: boolean;
  /** Participants (inscriptions) dont l'utilisateur est membre dans ce tournoi. */
  participantIds: string[];
  /** Membres-capitaines : seuls autorisés à saisir/confirmer si l'équipe en a désigné. */
  captainOf: string[];
}

/**
 * Contrôle d'accès par tournoi, côté serveur, sur chaque opération :
 *  - responsable de club (owner/manager) : tous les tournois de l'organisation ;
 *  - organisateur de l'organisation : tournois créés ou attribués ;
 *  - organisateur/arbitre invité : rôle sur le tournoi ;
 *  - joueur : membre associé à une inscription.
 */
@Injectable()
export class AccessService {
  constructor(private db: Db) {}

  async route(tournamentId: string): Promise<TournamentRoute> {
    if (!/^[0-9a-f-]{36}$/i.test(tournamentId)) throw notFound('Tournoi');
    const [r] = await this.db.query('SELECT * FROM route_tournament($1)', [tournamentId]);
    if (!r) throw notFound('Tournoi');
    return { id: r.id, orgId: r.org_id, visibility: r.visibility, published: r.published };
  }
  async routeSlug(slug: string): Promise<TournamentRoute> {
    const [r] = await this.db.query('SELECT * FROM route_tournament_slug($1)', [slug]);
    if (!r) throw notFound('Tournoi');
    return { id: r.id, orgId: r.org_id, visibility: r.visibility, published: r.published };
  }
  async routeMatch(matchId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(matchId)) throw notFound('Rencontre');
    const [r] = await this.db.query('SELECT * FROM route_match($1)', [matchId]);
    if (!r) throw notFound('Rencontre');
    return { matchId: r.id as string, orgId: r.org_id as string, tournamentId: r.tournament_id as string };
  }
  async routeParticipant(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Participant');
    const [r] = await this.db.query('SELECT * FROM route_participant($1)', [id]);
    if (!r) throw notFound('Participant');
    return { participantId: r.id as string, orgId: r.org_id as string, tournamentId: r.tournament_id as string };
  }

  /** Droits de l'utilisateur sur un tournoi (dans la transaction de son organisation). */
  async load(tx: Tx, ctx: RequestContext | undefined, tournamentId: string, orgId: string): Promise<Access> {
    const a: Access = { tournamentId, orgId, organizer: false, referee: false, participantIds: [], captainOf: [] };
    if (!ctx) return a;
    if (ctx.isPlatformAdmin) a.organizer = true;
    const m = await one(tx, 'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, ctx.userId]);
    const roles = (await many(tx, 'SELECT role FROM tournament_roles WHERE tournament_id = $1 AND user_id = $2', [tournamentId, ctx.userId])).map((r) => r.role);
    if (m && (m.role === 'owner' || m.role === 'manager')) a.organizer = true;
    if (m?.role === 'organizer') {
      const t = await one(tx, 'SELECT created_by FROM tournaments WHERE id = $1', [tournamentId]);
      if (t?.created_by === ctx.userId) a.organizer = true;
    }
    if (roles.includes('organizer')) a.organizer = true;
    if (roles.includes('referee')) a.referee = true;
    const parts = await many(tx,
      `SELECT pm.participant_id, pm.is_captain, EXISTS (SELECT 1 FROM participant_members x WHERE x.participant_id = pm.participant_id AND x.is_captain) has_captain
         FROM participant_members pm JOIN participants p ON p.id = pm.participant_id
        WHERE pm.tournament_id = $1 AND pm.user_id = $2 AND p.status IN ('confirmed','pending','waitlist','forfeit','withdrawn')`, [tournamentId, ctx.userId]);
    a.participantIds = parts.map((p) => p.participant_id);
    a.captainOf = parts.filter((p) => p.is_captain || !p.has_captain).map((p) => p.participant_id);
    return a;
  }

  /** Ouvre une transaction dans l'organisation du tournoi avec les droits de l'utilisateur. */
  async withTournament<T>(ctx: RequestContext | undefined, tournamentId: string, fn: (tx: Tx, a: Access, r: TournamentRoute) => Promise<T>): Promise<T> {
    const r = await this.route(tournamentId);
    return this.db.orgTx(r.orgId, async (tx) => fn(tx, await this.load(tx, ctx, tournamentId, r.orgId), r));
  }

  /** Idem, réservé aux organisateurs du tournoi. Même réponse 404 qu'un tournoi inexistant pour un tiers. */
  async asOrganizer<T>(ctx: RequestContext, tournamentId: string, fn: (tx: Tx, a: Access) => Promise<T>): Promise<T> {
    return this.withTournament(ctx, tournamentId, async (tx, a) => {
      if (!a.organizer) {
        if (a.referee || a.participantIds.length) throw forbidden('organizer_only', 'Action réservée aux organisateurs du tournoi');
        throw notFound('Tournoi');
      }
      return fn(tx, a);
    });
  }
}

/** Organisations où l'utilisateur peut créer et gérer des tournois. */
export async function orgRole(db: Db, userId: string, orgId: string): Promise<string | undefined> {
  const [m] = await db.query('SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
  return m?.role;
}
