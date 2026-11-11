import { Link } from 'react-router-dom';
import { FORMAT_LABELS, fmtDate, fmtTime, T_STATUS } from '../format';
import { useData, useSession } from '../session';
import { Loading, MatchCard, Pill } from '../components/ui';

export function Home() {
  const { me } = useSession();
  if (!me) return <Landing />;
  return (
    <>
      <PlayerSpace />
      {me.organizations.map((o) => <OrgTournaments key={o.id} org={o} />)}
      {!me.organizations.length && (
        <section className="card">
          <h2>Vous organisez des tournois ?</h2>
          <p className="muted">Créez l’espace de votre club pour lancer votre premier tournoi en quelques minutes.</p>
          <Link className="button secondary" to="/account#club">Créer mon club</Link>
        </section>
      )}
    </>
  );
}

function Landing() {
  return (
    <div className="hero">
      <h1>Vos tournois, de l’inscription au podium</h1>
      <p>Poules, tableaux, scores saisis par les joueurs et validés par l’adversaire, classements en direct. Sur téléphone, sans application à installer.</p>
      <div className="row wrap center">
        <Link className="button primary" to="/login?organizer=1">Créer un tournoi</Link>
        <Link className="button secondary" to="/login">Espace joueur</Link>
      </div>
    </div>
  );
}

function PlayerSpace() {
  const { data, loading } = useData<any>('/api/me/matches');
  const tournaments = useData<any[]>('/api/me/tournaments');
  if (loading) return <Loading />;
  const toConfirm = data?.matches.filter((m: any) => m.toConfirm) ?? [];
  const toReferee = data?.matches.filter((m: any) => m.role === 'referee' && !['completed', 'walkover', 'bye'].includes(m.status)) ?? [];
  const played = tournaments.data?.filter((t) => t.participant) ?? [];
  if (!data?.matches.length && !played.length && !tournaments.data?.length) return null;
  return (
    <section aria-labelledby="me-title">
      <h1 id="me-title">Mon espace</h1>
      {toConfirm.length > 0 && <div className="stack"><h2>À confirmer</h2>{toConfirm.map((m: any) => <MatchCard key={m.id} m={m} showTournament />)}</div>}
      {data?.next && (
        <div className="card next">
          <h2>Prochaine rencontre</h2>
          <p className="big">{data.next.side === 'home' ? data.next.away.name : data.next.home.name}</p>
          <p>{data.next.tournament.name} · {data.next.roundLabel}</p>
          <p className="big">{data.next.court ? `Terrain ${data.next.court}` : 'Terrain à venir'} · {data.next.scheduledAt ? `${fmtDate(data.next.scheduledAt)} à ${fmtTime(data.next.scheduledAt)}` : 'horaire à venir'}</p>
          <Link className="button primary" to={`/matches/${data.next.id}`}>Ouvrir la rencontre</Link>
        </div>
      )}
      {toReferee.length > 0 && <div className="stack"><h2>À arbitrer</h2>{toReferee.map((m: any) => <MatchCard key={m.id} m={m} showTournament />)}</div>}
      {tournaments.data && tournaments.data.length > 0 && (
        <div className="stack">
          <h2>Mes tournois</h2>
          {tournaments.data.map((t) => (
            <Link key={t.id} to={`/t/${t.id}`} className="card link-card">
              <strong>{t.name}</strong> <Pill>{T_STATUS[t.status]}</Pill>
              <div className="muted">{fmtDate(t.starts_at)}{t.venue_name ? ` · ${t.venue_name}` : ''}{t.participant ? ` · ${t.participant}` : ''}{t.roles?.includes('referee') ? ' · arbitre' : ''}</div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function OrgTournaments({ org }: { org: any }) {
  const { data } = useData<any[]>(`/api/tournaments?orgId=${org.id}`);
  return (
    <section aria-labelledby={`org-${org.id}`}>
      <div className="row between">
        <h2 id={`org-${org.id}`}>{org.name} <small className="muted">· offre {org.planLabel}</small></h2>
        <Link className="button primary" to={`/new?org=${org.id}`}>+ Nouveau tournoi</Link>
      </div>
      {!data ? <Loading /> : !data.length ? <p className="muted">Aucun tournoi pour l’instant.</p> : (
        <div className="cards">
          {data.map((t) => (
            <Link key={t.id} to={`/t/${t.id}`} className="card link-card">
              <div className="row between"><strong>{t.name}</strong><Pill tone={t.status === 'running' ? 'live' : t.status === 'finished' ? 'ok' : ''}>{T_STATUS[t.status]}</Pill></div>
              <div className="muted">{fmtDate(t.starts_at)} · {FORMAT_LABELS[t.format]} · {t.participants}/{t.max_participants} participants</div>
              {t.matches > 0 && <div className="progress" aria-label={`${t.completed} rencontres terminées sur ${t.matches}`}><span style={{ width: `${(100 * t.completed) / t.matches}%` }} /></div>}
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
