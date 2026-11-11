import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { del, download, patch, post, qrSrc } from '../api';
import { Bracket, ErrorBox, FinalRanking, GroupTable, Loading, MatchCard, Pill, PlanningGrid, useAction } from '../components/ui';
import { FORMAT_LABELS, fmtDateTime, MODE_LABELS, P_STATUS, T_STATUS } from '../format';
import { useData, useLive } from '../session';
import { parseQuickList } from './Wizard';

export function TournamentPage() {
  const { id } = useParams();
  const { data: v, error, reload } = useData<any>(`/api/tournaments/${id}`);
  const live = useLive(id ? `/api/tournaments/${id}/stream` : null, reload);
  const [q, setQ] = useSearchParams();
  if (error) return <ErrorBox error={error} />;
  if (!v) return <Loading />;
  const org = v.access.organizer;
  const tabs: [string, string][] = [
    ...(org ? [['dashboard', 'Tableau de bord'], ['participants', 'Participants']] as [string, string][] : []),
    ...(v.hasGroups ? [['groups', v.tournament.format === 'league' ? 'Classement' : 'Poules']] as [string, string][] : []),
    ...(v.matches.some((m: any) => m.stageKind === 'knockout') ? [['bracket', 'Tableau']] as [string, string][] : []),
    ['matches', 'Rencontres'], ['planning', 'Programme'], ['ranking', 'Classement final'],
    ...(org ? [['share', 'Partage & exports'], ['settings', 'Réglages'], ['history', 'Historique']] as [string, string][] : []),
  ];
  const tab = q.get('tab') ?? tabs[0][0];
  const t = v.tournament;
  const color = t.branding?.primaryColor;
  return (
    <div style={color ? ({ '--brand': color } as any) : undefined}>
      <header className="t-header">
        {t.branding?.logoUrl && <img src={t.branding.logoUrl} alt="" className="logo" />}
        <div>
          <h1>{t.name}</h1>
          <p className="muted">{fmtDateTime(t.startsAt)}{t.venueName ? ` · ${t.venueName}` : ''} · {MODE_LABELS[t.mode]} · {FORMAT_LABELS[t.format]}</p>
        </div>
        <div className="row wrap">
          <Pill tone={t.status === 'running' ? 'live' : t.status === 'finished' ? 'ok' : ''}>{T_STATUS[t.status]}</Pill>
          {!t.published && <Pill tone="warn">Non publié</Pill>}
          <span className={`live-dot ${live}`} title={live === 'live' ? 'Actualisation en direct' : 'Actualisation périodique'}>{live === 'live' ? 'En direct' : live === 'polling' ? 'Actualisation auto.' : ''}</span>
        </div>
      </header>
      <nav className="tabs" role="tablist" aria-label="Sections du tournoi">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setQ({ tab: k })}>{l}</button>)}
      </nav>
      <div role="tabpanel">
        {tab === 'dashboard' && <Dashboard v={v} reload={reload} />}
        {tab === 'participants' && <Participants v={v} reload={reload} />}
        {tab === 'groups' && <div className="cards">{v.stages.filter((s: any) => s.groups).flatMap((s: any) => s.groups.map((g: any) => <GroupBlock key={g.groupId} g={g} stage={s} v={v} reload={reload} />))}</div>}
        {tab === 'bracket' && <Bracket matches={v.matches} highlight={v.access.participantIds} />}
        {tab === 'matches' && <MatchesList v={v} />}
        {tab === 'planning' && <Planning v={v} reload={reload} />}
        {tab === 'ranking' && <FinalRanking ranking={v.ranking} />}
        {tab === 'share' && <Share v={v} reload={reload} />}
        {tab === 'settings' && <Settings v={v} reload={reload} />}
        {tab === 'history' && <History id={t.id} />}
      </div>
    </div>
  );
}

function Dashboard({ v, reload }: { v: any; reload: () => void }) {
  const d = v.dashboard;
  const { busy, error, run } = useAction();
  const t = v.tournament;
  const tiles: [string, number | string, string?][] = [
    ['Participants', d.participants], ['Rencontres', d.matches], ['Terminées', d.completed], ['En cours', d.inProgress],
    ['Restantes', d.remaining], ['À valider', d.awaitingValidation, d.awaitingValidation ? 'warn' : ''], ['Retards', d.late, d.late ? 'bad' : ''], ['Terrains libres', `${d.courtsAvailable}/${d.courts}`],
  ];
  return (
    <>
      <div className="tiles">{tiles.map(([l, n, tone]) => <div key={l} className={`tile ${tone ?? ''}`}><span className="n">{n}</span><span>{l}</span></div>)}</div>
      <section className="card">
        <h2>Actions rapides</h2>
        <div className="row wrap">
          {!t.generated && <button className="primary" disabled={busy} onClick={() => void run(async () => { await post(`/api/tournaments/${t.id}/generate`); reload(); })}>Générer les rencontres</button>}
          {t.generated && d.completed === 0 && <button className="secondary" disabled={busy} onClick={() => confirm('Refaire le tirage ? Les rencontres actuelles seront remplacées.') && void run(async () => { await post(`/api/tournaments/${t.id}/generate`, { reason: 'Nouveau tirage' }); reload(); })}>Refaire le tirage</button>}
          {!t.published && <button className="primary" disabled={busy} onClick={() => void run(async () => { await post(`/api/tournaments/${t.id}/publish`); reload(); })}>Publier</button>}
          {t.generated && <button className="secondary" disabled={busy} onClick={() => void run(async () => { const r = await post(`/api/tournaments/${t.id}/schedule`); alert(`${r.scheduled} rencontre(s) planifiée(s)${r.estimatedEnd ? `, fin estimée ${fmtDateTime(r.estimatedEnd)}` : ''}.${r.warnings.join(' ')}`); reload(); })}>Replanifier</button>}
          <Link className="button secondary" to="?tab=participants">Ajouter un joueur</Link>
          <Link className="button secondary" to="?tab=share">QR Codes & exports</Link>
        </div>
        <ErrorBox error={error} />
      </section>
      {d.anomalies.length > 0 && (
        <section className="card">
          <h2>À traiter</h2>
          <ul className="list">{d.anomalies.map((a: any, i: number) => <li key={i}>{a.matchId ? <Link to={`/matches/${a.matchId}`}>{a.message}</Link> : a.message}</li>)}</ul>
        </section>
      )}
      <section className="stack">
        <h2>Scores en attente</h2>
        {v.matches.filter((m: any) => ['awaiting_confirmation', 'disputed'].includes(m.status)).map((m: any) => <MatchCard key={m.id} m={m} />)}
        {!v.matches.some((m: any) => ['awaiting_confirmation', 'disputed'].includes(m.status)) && <p className="muted">Aucun score en attente.</p>}
      </section>
      <section className="stack">
        <h2>En cours</h2>
        {v.matches.filter((m: any) => ['in_progress', 'called'].includes(m.status)).map((m: any) => <MatchCard key={m.id} m={m} />)}
      </section>
    </>
  );
}

function GroupBlock({ g, stage, v, reload }: { g: any; stage: any; v: any; reload: () => void }) {
  const tie = g.rows.filter((r: any) => r.qualification === 'tie');
  const [order, setOrder] = useState<string[]>(tie.map((r: any) => r.participantId));
  const { busy, error, run } = useAction();
  return (
    <div>
      <GroupTable g={g} highlight={v.access.participantIds} />
      {v.access.organizer && tie.length > 1 && (
        <div className="card">
          <p><strong>Égalité à départager</strong> ({v.tournament.tiebreakerLabels.join(', ')} identiques). Indiquez l’ordre décidé (règlement, tirage au sort) :</p>
          <ol className="reorder">{order.map((pid, i) => (
            <li key={pid}>{g.rows.find((r: any) => r.participantId === pid)?.name}
              <button className="icon" aria-label="Monter" disabled={i === 0} onClick={() => { const a = [...order]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; setOrder(a); }}>↑</button></li>
          ))}</ol>
          <button className="primary" disabled={busy} onClick={() => { const reason = prompt('Motif (ex. tirage au sort public)'); if (reason) void run(async () => { await post(`/api/tournaments/${v.tournament.id}/stages/${stage.id}/tiebreak`, { group: g.name, order, reason }); reload(); }); }}>Valider l’ordre</button>
          <ErrorBox error={error} />
        </div>
      )}
      <div className="stack">{v.matches.filter((m: any) => m.group === g.name && m.stageId === stage.id).map((m: any) => <MatchCard key={m.id} m={m} highlight={v.access.participantIds} />)}</div>
    </div>
  );
}

function MatchesList({ v }: { v: any }) {
  const [filter, setFilter] = useState('all');
  const mine = v.access.participantIds as string[];
  const list = v.matches.filter((m: any) => m.status !== 'bye').filter((m: any) =>
    filter === 'all' ? true : filter === 'mine' ? mine.includes(m.home.id) || mine.includes(m.away.id) : filter === 'todo' ? !['completed', 'walkover', 'cancelled'].includes(m.status) : ['completed', 'walkover'].includes(m.status));
  return (
    <>
      <div className="row wrap" role="group" aria-label="Filtrer">
        {[['all', 'Toutes'], ...(mine.length ? [['mine', 'Mes rencontres']] : []), ['todo', 'À jouer'], ['done', 'Résultats']].map(([k, l]) => (
          <button key={k} className={filter === k ? 'chip active' : 'chip'} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>
      <div className="stack">{list.map((m: any) => <MatchCard key={m.id} m={m} highlight={mine} />)}</div>
    </>
  );
}

function Planning({ v, reload }: { v: any; reload: () => void }) {
  const { error, run } = useAction();
  const move = (matchId: string, court: number, at: string, swapWith?: string) => void run(async () => {
    const m = v.matches.find((x: any) => x.id === matchId);
    const r = await patch(`/api/matches/${matchId}/schedule`, { court, scheduledAt: at, locked: true, swapWith, version: m.version });
    if (r.warnings?.length) alert(r.warnings.join('\n'));
    reload();
  });
  return <><ErrorBox error={error} /><PlanningGrid matches={v.matches} courts={v.tournament.courts} onMove={v.access.organizer ? move : undefined} /></>;
}

function Participants({ v, reload }: { v: any; reload: () => void }) {
  const t = v.tournament;
  const { data: list, reload: reloadList } = useData<any[]>(`/api/tournaments/${t.id}/participants`);
  const [quick, setQuick] = useState('');
  const [csv, setCsv] = useState<{ text: string; report?: any } | null>(null);
  const [invite, setInvite] = useState<any>(null);
  const { busy, error, run } = useAction();
  const refresh = () => { reloadList(); reload(); };
  const add = () => void run(async () => { for (const p of parseQuickList(quick, t.mode, false)) await post(`/api/tournaments/${t.id}/participants`, p); setQuick(''); refresh(); });
  const status = (p: any, s: string) => {
    const reason = s === 'forfeit' || s === 'withdrawn' ? prompt('Motif (facultatif)') ?? undefined : undefined;
    if (s === 'forfeit' && !confirm(`Déclarer ${p.name} forfait ? Ses rencontres restantes seront perdues par forfait.`)) return;
    void run(async () => { await post(`/api/participants/${p.id}/status`, { status: s, reason }); refresh(); });
  };
  const counts = (list ?? []).reduce((a: any, p: any) => ({ ...a, [p.status]: (a[p.status] ?? 0) + 1 }), {});
  return (
    <>
      <p className="muted">{counts.confirmed ?? 0}/{t.maxParticipants} confirmés{counts.pending ? ` · ${counts.pending} à valider` : ''}{counts.waitlist ? ` · ${counts.waitlist} en liste d’attente` : ''} · {v.dashboard.checkedIn} présents</p>
      <section className="card form">
        <label>Ajout rapide ({t.mode === 'double' ? '« Prénom Nom / Prénom Nom ; niveau »' : '« Prénom Nom ; niveau »'}, une ligne par inscription)
          <textarea rows={3} value={quick} onChange={(e) => setQuick(e.target.value)} /></label>
        <div className="row wrap">
          <button className="primary" disabled={busy || !quick.trim()} onClick={add}>Ajouter</button>
          <label className="button secondary">Importer un CSV<input type="file" accept=".csv,text/csv" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) { const text = await f.text(); const report = await post(`/api/tournaments/${t.id}/participants/import`, { csv: text, dryRun: true }); setCsv({ text, report }); } }} /></label>
        </div>
        {csv?.report && (
          <div className="alert info">
            <p>Simulation : {csv.report.created} à créer, {csv.report.duplicates} doublon(s), {csv.report.errors} erreur(s).</p>
            {csv.report.results.filter((r: any) => r.status !== 'created').map((r: any) => <div key={r.line} className="small">Ligne {r.line} : {r.message}</div>)}
            <button className="primary" onClick={() => void run(async () => { await post(`/api/tournaments/${t.id}/participants/import`, { csv: csv.text }); setCsv(null); refresh(); })}>Importer</button>
          </div>
        )}
        <ErrorBox error={error} />
      </section>
      {invite && (
        <div className="card qr-card" role="dialog" aria-label="Invitation individuelle">
          <p><strong>{invite.name}</strong> : QR Code individuel (usage unique, {invite.expiresInDays} jours). À scanner par le joueur pour associer son compte, ou par vous pour pointer sa présence.</p>
          <img src={qrSrc(invite.url)} alt={`QR Code d’invitation de ${invite.name}`} width={180} height={180} />
          <input readOnly value={invite.url} onFocus={(e) => e.target.select()} aria-label="Lien d’invitation" />
          <button className="secondary" onClick={() => setInvite(null)}>Fermer</button>
        </div>
      )}
      {!list ? <Loading /> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th scope="col">Participant</th><th scope="col">Niveau</th><th scope="col">Statut</th><th scope="col">Joueurs</th><th scope="col">Actions</th></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong>{p.club && <div className="muted small">{p.club}</div>}</td>
                  <td>{p.rating ?? ''}{p.seed ? ` (TS ${p.seed})` : ''}</td>
                  <td><Pill tone={p.status === 'confirmed' ? 'ok' : p.status === 'forfeit' ? 'bad' : 'warn'}>{P_STATUS[p.status]}{p.waitlist_position ? ` #${p.waitlist_position}` : ''}</Pill>{p.checked_in_at && <Pill tone="ok">Présent</Pill>}</td>
                  <td>{p.members.map((m: any) => (
                    <div key={m.id} className="small">{m.first_name} {m.last_name} {m.linked ? '✓' : <button className="link" onClick={() => void run(async () => setInvite({ ...(await post(`/api/members/${m.id}/invite`)), name: `${m.first_name} ${m.last_name}` }))}>QR</button>}
                      {m.claim_pending && <span> · demande d’association <button className="link" onClick={() => void run(async () => { await post(`/api/members/${m.id}/claim-decision`, { tournamentId: t.id, approve: true }); refresh(); })}>accepter</button> <button className="link" onClick={() => void run(async () => { await post(`/api/members/${m.id}/claim-decision`, { tournamentId: t.id, approve: false }); refresh(); })}>refuser</button></span>}
                    </div>))}</td>
                  <td className="actions">
                    {p.status === 'confirmed' && <button className="link" onClick={() => void run(async () => { await patch(`/api/participants/${p.id}`, { checkedIn: !p.checked_in_at }); refresh(); })}>{p.checked_in_at ? 'Absent' : 'Présent'}</button>}
                    {['pending', 'waitlist'].includes(p.status) && <button className="link" onClick={() => status(p, 'confirmed')}>Confirmer</button>}
                    {p.status === 'pending' && <button className="link" onClick={() => status(p, 'refused')}>Refuser</button>}
                    {p.status === 'confirmed' && !t.generated && <button className="link" onClick={() => status(p, 'withdrawn')}>Désister</button>}
                    {p.status === 'confirmed' && t.generated && <button className="link danger" onClick={() => status(p, 'forfeit')}>Forfait</button>}
                    {p.status === 'confirmed' && t.generated && <ReplaceButton p={p} list={list} onDone={refresh} />}
                    {!t.generated && <button className="link danger" onClick={() => confirm(`Supprimer ${p.name} ?`) && void run(async () => { await del(`/api/participants/${p.id}`); refresh(); })}>Supprimer</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ReplaceButton({ p, list, onDone }: { p: any; list: any[]; onDone: () => void }) {
  const candidates = list.filter((x) => x.status === 'waitlist' || x.status === 'pending');
  const go = async () => {
    const choice = candidates.length ? prompt(`Remplaçant (numéro) :\n${candidates.map((c, i) => `${i + 1}. ${c.name}`).join('\n')}`) : null;
    const rep = choice ? candidates[Number(choice) - 1] : null;
    if (!rep) { if (!candidates.length) alert('Ajoutez d’abord le remplaçant (liste d’attente).'); return; }
    const reason = prompt('Motif du remplacement') ?? '';
    if (reason.length < 2) return;
    await post(`/api/participants/${p.id}/replace`, { replacementId: rep.id, reason }).catch((e) => alert(e.message));
    onDone();
  };
  return <button className="link" onClick={() => void go()}>Remplacer</button>;
}

function Share({ v }: { v: any; reload: () => void }) {
  const t = v.tournament;
  const [codes, setCodes] = useState<any>(null);
  const { error, run } = useAction();
  const load = (rotate = false) => run(async () => setCodes(await post(`/api/tournaments/${t.id}/qr-codes`, { rotate })));
  const exp = (what: string) => run(() => download(`/api/tournaments/${t.id}/export/${what}`, `${t.slug}-${what}`));
  return (
    <>
      <section className="card">
        <h2>QR Codes</h2>
        {!codes ? <button className="primary" onClick={() => void load()}>Afficher les QR Codes</button> : (
          <div className="qr-grid">
            <figure className="qr-card"><img src={qrSrc(codes.registration.url)} alt="QR Code d’inscription" width={200} height={200} /><figcaption>Inscription<br /><small>{codes.registration.url}</small></figcaption></figure>
            {t.visibility === 'public' && <figure className="qr-card"><img src={qrSrc(codes.public.url)} alt="QR Code de consultation publique" width={200} height={200} /><figcaption>Consultation publique<br /><a href={codes.public.url}>{codes.public.url}</a></figcaption></figure>}
          </div>
        )}
        {codes && <div className="row wrap"><button className="secondary" onClick={() => window.print()}>Imprimer</button><button className="secondary" onClick={() => confirm('Révoquer le lien d’inscription actuel et en créer un nouveau ?') && void load(true)}>Régénérer le lien d’inscription</button></div>}
        <p className="muted small">Les QR Codes individuels (association d’un joueur, présence) se génèrent depuis l’onglet Participants ; ils sont à usage unique, expirent et peuvent être révoqués.</p>
      </section>
      <section className="card">
        <h2>Exports</h2>
        <div className="row wrap">
          <button className="secondary" onClick={() => void exp('participants.csv')}>Participants (CSV)</button>
          <button className="secondary" onClick={() => void exp('participants.xlsx')}>Participants (Excel)</button>
          <button className="secondary" onClick={() => void exp('planning.csv')}>Planning (CSV)</button>
          <button className="secondary" onClick={() => void exp('results.xlsx')}>Résultats (Excel)</button>
          <button className="secondary" onClick={() => void exp('ranking.csv')}>Classement (CSV)</button>
          <Link className="button secondary" to={`/print/${t.id}`}>Rapport imprimable / PDF</Link>
        </div>
        <ErrorBox error={error} />
      </section>
      <Stats id={t.id} />
    </>
  );
}

function Stats({ id }: { id: string }) {
  const { data } = useData<any>(`/api/tournaments/${id}/stats`);
  if (!data) return null;
  return (
    <section className="card">
      <h2>Statistiques</h2>
      <ul>
        <li>{data.playedMatches}/{data.totalMatches} rencontres jouées · {data.walkovers} forfait(s)</li>
        {data.averageDurationMinutes !== null && <li>Durée moyenne : {data.averageDurationMinutes} min</li>}
        {data.participationRate !== null && <li>Présence : {data.participationRate} %</li>}
        <li>Victoires domicile / extérieur / nuls : {data.homeWins} / {data.awayWins} / {data.draws}</li>
        {data.byCourt.length > 0 && <li>Par terrain : {data.byCourt.map((c: any) => `T${c.court} : ${c.matches}`).join(' · ')}</li>}
      </ul>
    </section>
  );
}

function Settings({ v, reload }: { v: any; reload: () => void }) {
  const t = v.tournament;
  const [f, setF] = useState({ name: t.name, venueName: t.venueName ?? '', maxParticipants: t.maxParticipants, courts: t.courts, matchMinutes: t.matchMinutes, visibility: t.visibility,
    refereeOfficial: t.refereeOfficial, confirmationHours: t.confirmationHours, autoConfirmOnTimeout: t.autoConfirmOnTimeout, registrationOpen: t.registration?.open !== false, requireApproval: !!t.registration?.requireApproval,
    primaryColor: t.branding?.primaryColor ?? '#1f6feb', logoUrl: t.branding?.logoUrl ?? '' });
  const roles = useData<any[]>(`/api/tournaments/${t.id}/roles`);
  const [email, setEmail] = useState('');
  const { busy, error, run } = useAction();
  const save = () => void run(async () => {
    await patch(`/api/tournaments/${t.id}`, { name: f.name, venueName: f.venueName || undefined, maxParticipants: Number(f.maxParticipants), courts: Number(f.courts), matchMinutes: Number(f.matchMinutes),
      visibility: f.visibility, refereeOfficial: f.refereeOfficial, confirmationHours: Number(f.confirmationHours), autoConfirmOnTimeout: f.autoConfirmOnTimeout,
      registration: { ...t.registration, open: f.registrationOpen, requireApproval: f.requireApproval }, branding: { ...t.branding, primaryColor: f.primaryColor, logoUrl: f.logoUrl || undefined } });
    reload();
  });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <>
      <section className="card form">
        <h2>Général</h2>
        <label>Nom<input value={f.name} onChange={set('name')} /></label>
        <label>Lieu<input value={f.venueName} onChange={set('venueName')} /></label>
        <div className="grid3">
          <label>Participants max<input type="number" value={f.maxParticipants} onChange={set('maxParticipants')} /></label>
          <label>Terrains<input type="number" value={f.courts} onChange={set('courts')} /></label>
          <label>Durée d’un match (min)<input type="number" value={f.matchMinutes} onChange={set('matchMinutes')} /></label>
        </div>
        <label>Accès<select value={f.visibility} onChange={set('visibility')}><option value="public">Public</option><option value="private">Privé</option></select></label>
        <label className="check"><input type="checkbox" checked={f.registrationOpen} onChange={set('registrationOpen')} /> Inscriptions ouvertes</label>
        <label className="check"><input type="checkbox" checked={f.requireApproval} onChange={set('requireApproval')} /> Valider les inscriptions manuellement</label>
        <h2>Scores</h2>
        <label className="check"><input type="checkbox" checked={f.refereeOfficial} onChange={set('refereeOfficial')} /> Score saisi par l’arbitre directement officiel</label>
        <div className="grid2">
          <label>Délai de confirmation (h)<input type="number" value={f.confirmationHours} onChange={set('confirmationHours')} /></label>
          <label className="check"><input type="checkbox" checked={f.autoConfirmOnTimeout} onChange={set('autoConfirmOnTimeout')} /> Validation automatique à expiration</label>
        </div>
        <h2>Personnalisation</h2>
        <div className="grid2">
          <label>Couleur<input type="color" value={f.primaryColor} onChange={set('primaryColor')} /></label>
          <label>Logo (URL)<input type="url" value={f.logoUrl} onChange={set('logoUrl')} /></label>
        </div>
        <ErrorBox error={error} />
        <button className="primary" disabled={busy} onClick={save}>Enregistrer</button>
      </section>
      <section className="card form">
        <h2>Arbitres et co-organisateurs</h2>
        <ul className="list">{roles.data?.map((r) => (
          <li key={r.user_id + r.role} className="row between">{r.first_name} {r.last_name} · {r.role === 'referee' ? 'arbitre' : 'organisateur'}
            <button className="link danger" onClick={() => void run(async () => { await del(`/api/tournaments/${t.id}/roles/${r.user_id}/${r.role}`); roles.reload(); })}>Retirer</button></li>))}</ul>
        <label>Email du compte<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <div className="row wrap">
          <button className="secondary" onClick={() => void run(async () => { await post(`/api/tournaments/${t.id}/roles`, { email, role: 'referee' }); setEmail(''); roles.reload(); })}>Ajouter un arbitre</button>
          <button className="secondary" onClick={() => void run(async () => { await post(`/api/tournaments/${t.id}/roles`, { email, role: 'organizer' }); setEmail(''); roles.reload(); })}>Ajouter un organisateur</button>
        </div>
      </section>
      <section className="card">
        <h2>Zone sensible</h2>
        <button className="danger" onClick={() => confirm('Supprimer ce tournoi ? (archivé s’il contient des résultats)') && void run(async () => { await del(`/api/tournaments/${t.id}`); location.href = '/'; })}>Supprimer / archiver</button>
      </section>
    </>
  );
}

function History({ id }: { id: string }) {
  const { data } = useData<any[]>(`/api/tournaments/${id}/audit`);
  if (!data) return <Loading />;
  return (
    <ul className="list">
      {data.map((l) => (
        <li key={l.id}><strong>{l.action}</strong> · {l.entity} <small className="muted">{new Date(l.at).toLocaleString('fr-FR')} · {l.actor ?? 'système'}</small>{l.reason && <div className="small">Motif : {l.reason}</div>}</li>
      ))}
    </ul>
  );
}

/** Rapport imprimable (export PDF via l'impression du navigateur). */
export function PrintPage() {
  const { id } = useParams();
  const { data: v } = useData<any>(`/api/tournaments/${id}`);
  if (!v) return <Loading />;
  return (
    <div className="print">
      <button className="no-print secondary" onClick={() => window.print()}>Imprimer / enregistrer en PDF</button>
      <h1>{v.tournament.name}</h1>
      <p>{fmtDateTime(v.tournament.startsAt)} · {v.tournament.venueName}</p>
      <FinalRanking ranking={v.ranking} />
      {v.stages.filter((s: any) => s.groups).flatMap((s: any) => s.groups.map((g: any) => <GroupTable key={g.groupId} g={g} />))}
      <h2>Rencontres</h2>
      <table className="data"><tbody>{v.matches.filter((m: any) => m.status !== 'bye').map((m: any) => (
        <tr key={m.id}><td>{m.roundLabel}</td><td>{m.court ? `T${m.court}` : ''} {fmtDateTime(m.scheduledAt)}</td><td>{m.home.name}</td><td>{m.away.name}</td><td>{m.score?.sets ? m.score.sets.map((x: any) => `${x.home}-${x.away}`).join(' ') : m.score ? `${m.score.home}-${m.score.away}` : m.statusLabel}</td></tr>
      ))}</tbody></table>
    </div>
  );
}

