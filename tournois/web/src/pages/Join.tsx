import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, get, patch, post } from '../api';
import { Bracket, ErrorBox, FinalRanking, GroupTable, Loading, MatchCard, useAction } from '../components/ui';
import { fmtDateTime, MODE_LABELS } from '../format';
import { useData, useLive, useSession } from '../session';
import { AuthForm } from './Auth';

/**
 * Atterrissage d'un QR Code : 1) scan, 2) page du tournoi, 3) identification ou profil simplifié,
 * 4) inscription ou association au joueur créé par l'organisateur, 5) confirmation.
 */
export function JoinPage() {
  const { token } = useParams();
  const nav = useNavigate();
  const { me } = useSession();
  const [info, setInfo] = useState<any>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [result, setResult] = useState<any>(null);
  const { busy, error, run } = useAction();
  const [partner, setPartner] = useState({ firstName: '', lastName: '', email: '' });
  const [extra, setExtra] = useState({ club: '', category: '', name: '', rating: '' });
  useEffect(() => { get(`/api/join/${token}`).then(setInfo, setLoadError); }, [token]);
  useEffect(() => { if (info?.kind === 'match' && info.matchId && me) nav(`/matches/${info.matchId}`, { replace: true }); }, [info, me]);
  if (loadError) return <ErrorBox error={loadError} />;
  if (!info) return <Loading />;
  const t = info.tournament;
  const invalid: Record<string, string> = { revoked: 'Ce QR Code a été révoqué.', expired: 'Ce QR Code a expiré.', used: 'Cette invitation a déjà été utilisée.' };

  const register = () => void run(async () => {
    const members = [{ firstName: me!.user.firstName, lastName: me!.user.lastName }];
    if (t.mode === 'double') members.push({ firstName: partner.firstName, lastName: partner.lastName, ...(partner.email ? { email: partner.email } : {}) } as any);
    setResult(await post('/api/join/register', { token, participant: { members, club: extra.club || undefined, category: extra.category || undefined, name: extra.name || undefined, rating: extra.rating ? Number(extra.rating) : undefined } }));
  });
  const claim = () => void run(async () => setResult({ ...(await post('/api/join/claim', { token })), claimed: true }));

  return (
    <div className="narrow">
      <section className="card t-intro" style={t.branding?.primaryColor ? ({ '--brand': t.branding.primaryColor } as any) : undefined}>
        {t.branding?.logoUrl && <img src={t.branding.logoUrl} alt="" className="logo" />}
        <h1>{t.name}</h1>
        <p>{fmtDateTime(t.startsAt)}{t.venueName ? ` · ${t.venueName}` : ''} · {MODE_LABELS[t.mode]}</p>
        <p><Link to={`/p/${t.slug}`}>Voir le tournoi</Link></p>
      </section>
      {info.invalid ? <div className="alert bad">{invalid[info.invalid]} Demandez un nouveau QR Code à l’organisateur.</div>
        : result ? (
          <section className="card">
            {result.claimed ? <h2>✓ Votre compte est associé à {info.member?.participant}</h2> : (
              <h2>{result.status === 'confirmed' ? '✓ Inscription confirmée' : result.status === 'waitlist' ? `Liste d’attente : position ${result.waitlistPosition}` : 'Inscription enregistrée : en attente de validation'}</h2>
            )}
            {result.invites?.length > 0 && (
              <div className="alert info">
                <p>Envoyez ce lien à votre partenaire pour qu’il rejoigne l’équipe :</p>
                {result.invites.map((i: any) => (
                  <div key={i.memberId} className="stack">
                    <strong>{i.name}</strong>
                    <input readOnly value={i.url} onFocus={(e) => e.target.select()} aria-label={`Lien d’invitation de ${i.name}`} />
                    {'share' in navigator && <button className="secondary" onClick={() => void (navigator as any).share({ title: t.name, url: i.url })}>Partager</button>}
                  </div>
                ))}
              </div>
            )}
            <Link className="button primary" to={`/t/${result.tournamentId}`}>Accéder au tournoi</Link>
          </section>
        ) : !me ? (
          <AuthForm intro={info.kind === 'participant' ? `Connectez-vous ou créez votre profil pour être associé à ${info.member?.participant}.` : 'Créez votre profil en quelques secondes pour vous inscrire.'} />
        ) : info.kind === 'participant' ? (
          <section className="card">
            <h2>Rejoindre {info.member?.participant}</h2>
            {info.member?.linked ? <p>Ce joueur est déjà associé à un compte.</p> : <p>Associer votre compte ({me.user.firstName} {me.user.lastName}) à <strong>{info.member?.firstName}</strong> dans <strong>{info.member?.participant}</strong> ?</p>}
            <ErrorBox error={error} />
            {!info.member?.linked && <button className="primary block" disabled={busy} onClick={claim}>Oui, c’est moi</button>}
          </section>
        ) : info.kind === 'tournament' ? (
          !t.registrationOpen ? <div className="alert warn">Les inscriptions sont closes. <Link to={`/p/${t.slug}`}>Consulter le tournoi</Link></div> : (
            <section className="card form">
              <h2>Inscription</h2>
              <p>Joueur : <strong>{me.user.firstName} {me.user.lastName}</strong></p>
              {t.mode === 'double' && (
                <fieldset><legend>Partenaire</legend>
                  <div className="grid2">
                    <label>Prénom<input required value={partner.firstName} onChange={(e) => setPartner({ ...partner, firstName: e.target.value })} /></label>
                    <label>Nom<input required value={partner.lastName} onChange={(e) => setPartner({ ...partner, lastName: e.target.value })} /></label>
                  </div>
                  <label>Email du partenaire <small className="muted">(facultatif)</small><input type="email" value={partner.email} onChange={(e) => setPartner({ ...partner, email: e.target.value })} /></label>
                </fieldset>
              )}
              {t.mode === 'team' && <label>Nom de l’équipe<input required value={extra.name} onChange={(e) => setExtra({ ...extra, name: e.target.value })} /></label>}
              <div className="grid2">
                <label>Club <small className="muted">(facultatif)</small><input value={extra.club} onChange={(e) => setExtra({ ...extra, club: e.target.value })} /></label>
                <label>Niveau / classement <small className="muted">(facultatif)</small><input inputMode="decimal" value={extra.rating} onChange={(e) => setExtra({ ...extra, rating: e.target.value })} /></label>
              </div>
              {t.categories?.length > 0 && <label>Catégorie<select required value={extra.category} onChange={(e) => setExtra({ ...extra, category: e.target.value })}><option value="" />{t.categories.map((c: string) => <option key={c}>{c}</option>)}</select></label>}
              <ErrorBox error={error} />
              <button className="primary block" disabled={busy} onClick={register}>M’inscrire</button>
            </section>
          )
        ) : <AuthForm intro="Connectez-vous pour accéder à la rencontre." />}
    </div>
  );
}

/** Page publique (URL et QR Code de consultation) : sans connexion, actualisée en direct. */
export function PublicPage() {
  const { slug } = useParams();
  const { data: v, error, reload } = useData<any>(`/api/public/tournaments/${slug}`);
  const live = useLive(slug ? `/api/public/tournaments/${slug}/stream` : null, reload);
  const [tab, setTab] = useState('live');
  if (error) return <ErrorBox error={error} />;
  if (!v) return <Loading />;
  const t = v.tournament;
  const current = v.matches.filter((m: any) => ['in_progress', 'called'].includes(m.status));
  const upcoming = v.matches.filter((m: any) => ['scheduled', 'to_schedule'].includes(m.status) && m.home.id && m.away.id).sort((a: any, b: any) => String(a.scheduledAt).localeCompare(String(b.scheduledAt))).slice(0, 10);
  const recent = v.matches.filter((m: any) => ['completed', 'walkover'].includes(m.status)).sort((a: any, b: any) => String(b.completedAt).localeCompare(String(a.completedAt))).slice(0, 10);
  return (
    <div style={t.branding?.primaryColor ? ({ '--brand': t.branding.primaryColor } as any) : undefined}>
      <header className="t-header">
        {t.branding?.logoUrl && <img src={t.branding.logoUrl} alt="" className="logo" />}
        <div><h1>{t.name}</h1><p className="muted">{fmtDateTime(t.startsAt)}{t.venueName ? ` · ${t.venueName}` : ''}</p></div>
        <span className={`live-dot ${live}`}>{live === 'live' ? 'En direct' : 'Actualisation auto.'}</span>
      </header>
      <nav className="tabs" role="tablist">
        {[['live', 'Direct'], ...(v.hasGroups ? [['groups', 'Poules']] : []), ...(v.matches.some((m: any) => m.stageKind === 'knockout') ? [['bracket', 'Tableau']] : []), ['results', 'Résultats'], ['ranking', 'Classement']].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>
      {tab === 'live' && (
        <>
          <h2>En cours</h2>{current.length ? <div className="stack">{current.map((m: any) => <MatchCard key={m.id} m={m} />)}</div> : <p className="muted">Aucune rencontre en cours.</p>}
          <h2>À venir</h2><div className="stack">{upcoming.map((m: any) => <MatchCard key={m.id} m={m} />)}</div>
          <h2>Derniers résultats</h2><div className="stack">{recent.map((m: any) => <MatchCard key={m.id} m={m} />)}</div>
        </>
      )}
      {tab === 'groups' && <div className="cards">{v.stages.filter((s: any) => s.groups).flatMap((s: any) => s.groups.map((g: any) => <GroupTable key={g.groupId} g={g} />))}</div>}
      {tab === 'bracket' && <Bracket matches={v.matches} />}
      {tab === 'results' && <div className="stack">{v.matches.filter((m: any) => ['completed', 'walkover'].includes(m.status)).map((m: any) => <MatchCard key={m.id} m={m} />)}</div>}
      {tab === 'ranking' && <FinalRanking ranking={v.ranking} />}
    </div>
  );
}

export function AccountPage() {
  const { me, refresh, logout } = useSession();
  const [club, setClub] = useState('');
  const { busy, error, run } = useAction();
  const admin = useData<any[]>(me?.isPlatformAdmin ? '/api/admin/organizations' : null);
  if (!me) return <AuthForm />;
  const exportData = () => void run(async () => {
    const data = await get('/api/me/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    Object.assign(document.createElement('a'), { href: url, download: 'mes-donnees.json' }).click();
  });
  return (
    <div className="narrow">
      <h1>Mon compte</h1>
      <section className="card row between"><p>{me.user.firstName} {me.user.lastName}<br /><span className="muted">{me.user.email}</span></p><button className="secondary" onClick={() => { logout(); location.href = '/'; }}>Déconnexion</button></section>
      <section className="card form" id="club">
        <h2>Clubs</h2>
        <ul className="list">{me.organizations.map((o) => <li key={o.id}>{o.name} · {o.role === 'owner' ? 'responsable' : o.role === 'manager' ? 'co-responsable' : 'organisateur'} · offre {o.planLabel} <OrgMembers orgId={o.id} canEdit={o.role !== 'organizer'} /></li>)}</ul>
        <label>Créer un club<input value={club} onChange={(e) => setClub(e.target.value)} placeholder="Nom du club ou de l’association" /></label>
        <button className="secondary" disabled={busy || club.length < 2} onClick={() => void run(async () => { await post('/api/organizations', { name: club }); setClub(''); await refresh(); })}>Créer</button>
      </section>
      <section className="card">
        <h2>Mes données</h2>
        <div className="row wrap">
          <button className="secondary" onClick={exportData}>Exporter mes données</button>
          <button className="danger" onClick={() => confirm('Supprimer définitivement votre compte ? Vos résultats seront conservés de façon anonyme.') && void run(async () => { await del('/api/me'); logout(); location.href = '/'; })}>Supprimer mon compte</button>
        </div>
        <ErrorBox error={error} />
      </section>
      {admin.data && (
        <section className="card">
          <h2>Administration de la plateforme</h2>
          <table className="data"><tbody>{admin.data.map((o) => (
            <tr key={o.id}><td>{o.name}</td><td>{o.members} membre(s)</td><td>
              <select value={o.plan} onChange={(e) => void run(async () => { await patch(`/api/admin/organizations/${o.id}`, { plan: e.target.value }); admin.reload(); })}>
                <option value="free">Gratuit</option><option value="club">Club</option><option value="pro">Pro</option></select></td></tr>
          ))}</tbody></table>
        </section>
      )}
    </div>
  );
}

function OrgMembers({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const { data, reload } = useData<any[]>(open ? `/api/organizations/${orgId}/members` : null);
  const [email, setEmail] = useState('');
  const { error, run } = useAction();
  if (!open) return <button className="link" onClick={() => setOpen(true)}>Organisateurs</button>;
  return (
    <div className="stack">
      <ul>{data?.map((m) => <li key={m.id}>{m.first_name} {m.last_name} ({m.role})</li>)}</ul>
      {canEdit && <div className="row"><input type="email" placeholder="email@exemple.fr" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email de l’organisateur" /><button className="secondary" onClick={() => void run(async () => { await post(`/api/organizations/${orgId}/members`, { email, role: 'organizer' }); setEmail(''); reload(); })}>Ajouter</button></div>}
      <ErrorBox error={error} />
    </div>
  );
}
