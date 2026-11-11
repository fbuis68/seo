import { ReactNode, useEffect, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { ApiError, get, post } from '../api';
import { fmtTime, scoreText, statusTone } from '../format';
import { useSession } from '../session';

export function Layout({ children }: { children: ReactNode }) {
  const { me, logout } = useSession();
  const nav = useNavigate();
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!me) return;
    const load = () => get<any[]>('/api/me/notifications').then((n) => setUnread(n.filter((x) => !x.read_at).length)).catch(() => undefined);
    void load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, [me]);
  return (
    <>
      <a href="#main" className="skip">Aller au contenu</a>
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Accueil">🏆 <span>Tournois</span></Link>
        <nav aria-label="Navigation principale">
          {me ? (
            <>
              <NavLink to="/">Accueil</NavLink>
              <NavLink to="/notifications" aria-label={`Notifications${unread ? ` (${unread} non lues)` : ''}`}>🔔{unread > 0 && <span className="badge">{unread}</span>}</NavLink>
              <NavLink to="/account">Compte</NavLink>
              <button className="link hide-mobile" onClick={() => { logout(); nav('/'); }}>Déconnexion</button>
            </>
          ) : <NavLink to="/login">Connexion</NavLink>}
        </nav>
      </header>
      <main id="main" className="container">{children}</main>
    </>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  return <div className="alert bad" role="alert">{e.message ?? String(error)}{e.details && Array.isArray(e.details) && e.details.length > 1 && <ul>{e.details.map((d: any, i: number) => <li key={i}>{d.field} : {d.message}</li>)}</ul>}</div>;
}

export const Loading = () => <p className="muted" aria-live="polite">Chargement…</p>;

export function Pill({ tone, children }: { tone?: string; children: ReactNode }) {
  return <span className={`pill ${tone ?? ''}`}>{children}</span>;
}

/** Action asynchrone avec état et message d'erreur. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError(e); return undefined; } finally { setBusy(false); }
  };
  return { busy, error, run, setError };
}

export function MatchCard({ m, highlight, showTournament }: { m: any; highlight?: string[]; showTournament?: boolean }) {
  const won = (id: string | null) => m.winnerId && id === m.winnerId;
  const side = (s: any) => (
    <div className={`side ${won(s.id) ? 'won' : ''} ${highlight?.includes(s.id) ? 'me' : ''} ${s.placeholder ? 'placeholder' : ''}`}>{s.name}</div>
  );
  return (
    <Link to={`/matches/${m.id}`} className={`match-card ${statusTone(m.status)}`} aria-label={`${m.home.name} contre ${m.away.name}, ${m.statusLabel}`}>
      <div className="match-meta">
        <span>{showTournament && m.tournament ? `${m.tournament.name} · ` : ''}{m.roundLabel}</span>
        <span>{m.court ? `Terrain ${m.court}` : ''}{m.scheduledAt ? ` · ${fmtTime(m.scheduledAt)}` : ''}</span>
      </div>
      <div className="match-body">
        <div className="sides">{side(m.home)}{side(m.away)}</div>
        <div className="match-score">{m.status === 'bye' ? 'Exempt' : scoreText(m.score) || <Pill tone={statusTone(m.status)}>{m.statusLabel}</Pill>}</div>
      </div>
      {m.toConfirm && <div className="alert warn small">Score à confirmer</div>}
    </Link>
  );
}

/** Saisie d'un score selon les règles du tournoi (sets/manches ou score unique). */
export function ScoreForm({ scoring, homeName, awayName, initial, onSubmit, busy, submitLabel = 'Enregistrer le score' }:
  { scoring: any; homeName: string; awayName: string; initial?: any; onSubmit: (score: any) => void; busy?: boolean; submitLabel?: string }) {
  const toWin = scoring.setsToWin ?? 2;
  const maxSets = toWin * 2 - 1;
  const [sets, setSets] = useState<{ home: string; away: string }[]>(
    initial?.sets?.map((s: any) => ({ home: String(s.home), away: String(s.away) })) ?? Array.from({ length: toWin }, () => ({ home: '', away: '' })));
  const [pts, setPts] = useState({ home: initial?.home !== undefined ? String(initial.home) : '', away: initial?.away !== undefined ? String(initial.away) : '' });
  const [retired, setRetired] = useState<'' | 'home' | 'away'>(initial?.retired ?? '');
  const num = (v: string) => (v === '' ? NaN : Number(v));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (scoring.mode === 'points') onSubmit({ home: num(pts.home), away: num(pts.away), ...(retired ? { retired } : {}) });
    else onSubmit({ sets: sets.filter((s) => s.home !== '' || s.away !== '').map((s) => ({ home: num(s.home), away: num(s.away) })), ...(retired ? { retired } : {}) });
  };
  const input = (value: string, set: (v: string) => void, label: string) => (
    <input inputMode="numeric" pattern="[0-9]*" aria-label={label} className="score-input" value={value} onChange={(e) => set(e.target.value.replace(/\D/g, '').slice(0, 3))} />
  );
  return (
    <form onSubmit={submit} className="score-form">
      {scoring.mode === 'points' ? (
        <div className="score-grid">
          <div className="score-row"><span className="who">{homeName}</span>{input(pts.home, (v) => setPts({ ...pts, home: v }), `Score ${homeName}`)}</div>
          <div className="score-row"><span className="who">{awayName}</span>{input(pts.away, (v) => setPts({ ...pts, away: v }), `Score ${awayName}`)}</div>
        </div>
      ) : (
        <table className="score-table">
          <thead><tr><th scope="col"><span className="sr">Équipe</span></th>{sets.map((_, i) => <th key={i} scope="col">{scoring.superTiebreak && i === maxSets - 1 ? 'STB' : `S${i + 1}`}</th>)}</tr></thead>
          <tbody>
            {(['home', 'away'] as const).map((side) => (
              <tr key={side}><th scope="row" className="who">{side === 'home' ? homeName : awayName}</th>
                {sets.map((s, i) => <td key={i}>{input(s[side], (v) => setSets(sets.map((x, j) => (j === i ? { ...x, [side]: v } : x))), `${side === 'home' ? homeName : awayName}, manche ${i + 1}`)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row wrap">
        {scoring.mode === 'sets' && sets.length < maxSets && <button type="button" className="secondary" onClick={() => setSets([...sets, { home: '', away: '' }])}>+ Manche</button>}
        {scoring.mode === 'sets' && sets.length > 1 && <button type="button" className="secondary" onClick={() => setSets(sets.slice(0, -1))}>− Manche</button>}
        <label className="inline">Abandon :
          <select value={retired} onChange={(e) => setRetired(e.target.value as any)}>
            <option value="">non</option><option value="home">{homeName}</option><option value="away">{awayName}</option>
          </select>
        </label>
      </div>
      <button type="submit" disabled={busy} className="primary block">{busy ? 'Envoi…' : submitLabel}</button>
    </form>
  );
}

export function GroupTable({ g, highlight }: { g: any; highlight?: string[] }) {
  const q: Record<string, [string, string]> = { qualified: ['Qualifié', 'ok'], provisional: ['Provisoire', 'warn'], tie: ['Égalité', 'bad'], eliminated: ['Éliminé', 'muted'] };
  return (
    <section className="card" aria-labelledby={`g-${g.groupId}`}>
      <h3 id={`g-${g.groupId}`}>{g.name === 'Championnat' ? 'Classement' : `Poule ${g.name}`} {!g.complete && g.pendingMatches > 0 && <small className="muted">· {g.pendingMatches} rencontre(s) à jouer</small>}</h3>
      <div className="table-wrap">
        <table className="standings">
          <thead><tr><th scope="col">#</th><th scope="col">Participant</th><th scope="col" title="Matchs joués">J</th><th scope="col" title="Victoires">V</th><th scope="col" title="Nuls">N</th><th scope="col" title="Défaites">D</th><th scope="col" title="Sets/manches">Sets</th><th scope="col" title="Différence de jeux/points">Diff</th><th scope="col">Pts</th><th scope="col"><span className="sr">Qualification</span></th></tr></thead>
          <tbody>
            {g.rows.map((r: any) => (
              <tr key={r.participantId} className={highlight?.includes(r.participantId) ? 'me' : ''}>
                <td>{r.rank}{r.tied ? '=' : ''}</td><td>{r.name}{r.manual && <span title="Départage par l’organisateur"> *</span>}</td><td>{r.played}</td><td>{r.wins}</td><td>{r.draws}</td><td>{r.losses}</td>
                <td>{r.setsWon}-{r.setsLost}</td><td>{r.gameDiff > 0 ? `+${r.gameDiff}` : r.gameDiff}</td><td><strong>{r.points}</strong></td>
                <td>{r.qualification && <Pill tone={q[r.qualification][1]}>{q[r.qualification][0]}</Pill>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Tableau à élimination directe : une colonne par tour, défilement horizontal sur mobile. */
export function Bracket({ matches, highlight }: { matches: any[]; highlight?: string[] }) {
  const ko = matches.filter((m) => m.stageKind === 'knockout');
  if (!ko.length) return <p className="muted">Pas de tableau à élimination directe.</p>;
  const rounds = [...new Set(ko.filter((m) => m.key !== 'P3').map((m) => m.round))].sort((a, b) => a - b);
  const p3 = ko.find((m) => m.key === 'P3');
  return (
    <div className="bracket" role="list" aria-label="Tableau">
      {rounds.map((r) => {
        const ms = ko.filter((m) => m.round === r && m.key !== 'P3').sort((a, b) => a.position - b.position);
        return (
          <div key={r} className="bracket-round" role="listitem">
            <h3>{ms[0]?.roundLabel}</h3>
            <div className="bracket-matches">{ms.map((m) => <MatchCard key={m.id} m={m} highlight={highlight} />)}</div>
          </div>
        );
      })}
      {p3 && <div className="bracket-round" role="listitem"><h3>Petite finale</h3><div className="bracket-matches"><MatchCard m={p3} highlight={highlight} /></div></div>}
    </div>
  );
}

export function FinalRanking({ ranking }: { ranking: any }) {
  if (!ranking?.rows?.length) return <p className="muted">Le classement apparaîtra au fil des résultats.</p>;
  return (
    <section className="card">
      <h3>Classement général {!ranking.complete && <small className="muted">· provisoire</small>}</h3>
      <ol className="ranking">
        {ranking.rows.map((r: any) => (
          <li key={r.participantId}><span className="rank">{r.rank}{r.tied ? '=' : ''}</span><span>{r.name}</span><small className="muted">{r.reached}</small></li>
        ))}
      </ol>
    </section>
  );
}

/** Planning terrains × créneaux ; glisser-déposer d'une rencontre vers une case (échange si occupée). */
export function PlanningGrid({ matches, courts, onMove }: { matches: any[]; courts: number; onMove?: (matchId: string, court: number, at: string, swapWith?: string) => void }) {
  const scheduled = matches.filter((m) => m.scheduledAt && m.court && m.status !== 'bye');
  const times = [...new Set(scheduled.map((m) => m.scheduledAt as string))].sort();
  const [drag, setDrag] = useState<string | null>(null);
  const cell = (court: number, t: string) => scheduled.find((m) => m.court === court && m.scheduledAt === t);
  const unscheduled = matches.filter((m) => !m.scheduledAt && m.status !== 'bye' && !['completed', 'walkover', 'cancelled'].includes(m.status));
  return (
    <>
      <div className="table-wrap">
        <table className="planning">
          <thead><tr><th scope="col">Heure</th>{Array.from({ length: courts }, (_, i) => <th key={i} scope="col">Terrain {i + 1}</th>)}</tr></thead>
          <tbody>
            {times.map((t) => (
              <tr key={t}>
                <th scope="row">{fmtTime(t)}</th>
                {Array.from({ length: courts }, (_, i) => {
                  const m = cell(i + 1, t);
                  return (
                    <td key={i} onDragOver={(e) => onMove && e.preventDefault()} onDrop={() => { if (drag && onMove && drag !== m?.id) onMove(drag, i + 1, t, m?.id); setDrag(null); }}>
                      {m && (
                        <div draggable={!!onMove && !['completed', 'walkover'].includes(m.status)} onDragStart={() => setDrag(m.id)} className={`slot ${statusTone(m.status)}`}>
                          <Link to={`/matches/${m.id}`}><small>{m.key}</small><br />{m.home.name}<br />{m.away.name}</Link>
                          {scoreText(m.score) && <div className="muted">{scoreText(m.score)}</div>}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {onMove && <p className="muted small">Glissez une rencontre sur une autre case pour la déplacer ou l’échanger (ordinateur et tablette). La fiche de la rencontre permet aussi de modifier terrain et horaire.</p>}
      {unscheduled.length > 0 && <div className="alert warn">{unscheduled.length} rencontre(s) sans créneau : ajoutez des terrains ou prolongez la journée, puis relancez la planification.</div>}
    </>
  );
}

export function Notifications() {
  const [list, setList] = useState<any[] | null>(null);
  useEffect(() => { get<any[]>('/api/me/notifications').then((l) => { setList(l); void post('/api/me/notifications/read'); }); }, []);
  if (!list) return <Loading />;
  return (
    <>
      <h1>Notifications</h1>
      {!list.length && <p className="muted">Aucune notification.</p>}
      <ul className="list">
        {list.map((n) => (
          <li key={n.id} className={n.read_at ? '' : 'unread'}>
            {n.link ? <Link to={n.link}><strong>{n.title}</strong></Link> : <strong>{n.title}</strong>}
            {n.body && <div>{n.body}</div>}
            <small className="muted">{new Date(n.created_at).toLocaleString('fr-FR')}</small>
          </li>
        ))}
      </ul>
    </>
  );
}
